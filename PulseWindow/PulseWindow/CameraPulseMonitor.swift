@preconcurrency import AVFoundation
import Combine
import Foundation
import Vision

struct CameraOption: Identifiable, Hashable {
    let id: String
    let name: String
    let position: AVCaptureDevice.Position
}

struct RGBValue: Sendable {
    var red: Double
    var green: Double
    var blue: Double

    static let zero = RGBValue(red: 0, green: 0, blue: 0)

    subscript(channel: Int) -> Double {
        switch channel {
        case 0: red
        case 1: green
        default: blue
        }
    }
}

struct CameraFrameResult: Sendable {
    let timestamp: Double
    let frameSize: CGSize
    let faceBox: CGRect?
    let regions: [RGBValue]
    let bodyRegions: [CGRect]
    let bodyMotion: [Double]?
}

final class CameraFrameProcessor: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    var onResult: (@Sendable (CameraFrameResult) -> Void)?

    private var frameNumber = 0
    private var lastFace: VNFaceObservation?
    private var lastFaceTimestamp = 0.0
    private var lastBodyRegions = [CGRect]()
    private var lastBodyTimestamp = 0.0
    private var previousMotionGrids: [[Double]?] = [nil, nil, nil]
    private var cumulativeMotion = [0.0, 0.0, 0.0]
    private var lastMotionTimestamp = 0.0
    private static let motionGridSize = 24

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
        let frameSize = CGSize(
            width: CVPixelBufferGetWidth(pixelBuffer),
            height: CVPixelBufferGetHeight(pixelBuffer)
        )
        frameNumber += 1

        if frameNumber % 5 == 0 {
            let faceRequest = VNDetectFaceRectanglesRequest()
            let bodyRequest = VNDetectHumanBodyPoseRequest()
            let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up)
            try? handler.perform([faceRequest, bodyRequest])
            if let face = faceRequest.results?.max(by: {
                $0.boundingBox.width * $0.boundingBox.height <
                    $1.boundingBox.width * $1.boundingBox.height
            }) {
                lastFace = face
                lastFaceTimestamp = timestamp
            }
            if let body = bodyRequest.results?.first,
               let left = try? body.recognizedPoint(.leftShoulder),
               let right = try? body.recognizedPoint(.rightShoulder),
               let regions = Self.upperBodyRegions(left: left, right: right) {
                lastBodyRegions = regions
                lastBodyTimestamp = timestamp
            }
        }

        guard let face = lastFace, timestamp - lastFaceTimestamp <= 1.0 else {
            onResult?(CameraFrameResult(
                timestamp: timestamp,
                frameSize: frameSize,
                faceBox: nil,
                regions: [],
                bodyRegions: [],
                bodyMotion: nil
            ))
            return
        }

        let colours = Self.averageRegionColours(pixelBuffer, face: face)
        let visibleBodyRegions = timestamp - lastBodyTimestamp <= 0.9 ? lastBodyRegions : []
        let motion = measureBodyMotion(pixelBuffer, regions: visibleBodyRegions, timestamp: timestamp)
        onResult?(CameraFrameResult(
            timestamp: timestamp,
            frameSize: frameSize,
            faceBox: face.boundingBox,
            regions: colours,
            bodyRegions: motion.regions,
            bodyMotion: motion.values
        ))
    }

    private func measureBodyMotion(
        _ buffer: CVPixelBuffer,
        regions: [CGRect],
        timestamp: Double
    ) -> (regions: [CGRect], values: [Double]?) {
        guard regions.count == 3 else {
            previousMotionGrids = [nil, nil, nil]
            return ([], nil)
        }
        if lastMotionTimestamp > 0, timestamp - lastMotionTimestamp > 1 {
            previousMotionGrids = [nil, nil, nil]
        }
        lastMotionTimestamp = timestamp
        let grids = Self.grayMotionGrids(buffer, regions: regions)
        guard grids.count == 3 else { return (regions, nil) }
        var produced = false
        for index in grids.indices {
            if let previous = previousMotionGrids[index],
               let flow = Self.verticalOpticalFlow(previous: previous, current: grids[index]) {
                cumulativeMotion[index] += flow
                produced = true
            }
            previousMotionGrids[index] = grids[index]
        }
        return (regions, produced ? cumulativeMotion : nil)
    }

    private static func upperBodyRegions(
        left: VNRecognizedPoint,
        right: VNRecognizedPoint
    ) -> [CGRect]? {
        guard left.confidence >= 0.55, right.confidence >= 0.55 else { return nil }
        let span = abs(right.location.x - left.location.x)
        let shoulderY = (left.location.y + right.location.y) / 2
        guard span >= 0.16, shoulderY >= 0.18 else { return nil }
        let minX = min(left.location.x, right.location.x)
        let regionHeight = min(span * 0.42, shoulderY - 0.01)
        guard regionHeight >= 0.08 else { return nil }
        let raw = [
            CGRect(x: minX + span * 0.18, y: shoulderY - span * 0.48,
                   width: span * 0.64, height: regionHeight),
            CGRect(x: minX - span * 0.04, y: shoulderY - span * 0.34,
                   width: span * 0.38, height: regionHeight * 0.72),
            CGRect(x: minX + span * 0.66, y: shoulderY - span * 0.34,
                   width: span * 0.38, height: regionHeight * 0.72),
        ]
        return raw.map { $0.intersection(CGRect(x: 0, y: 0, width: 1, height: 1)) }
    }

    private static func grayMotionGrids(_ buffer: CVPixelBuffer, regions: [CGRect]) -> [[Double]] {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let baseAddress = CVPixelBufferGetBaseAddress(buffer) else { return [] }
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        let pointer = baseAddress.assumingMemoryBound(to: UInt8.self)
        return regions.map { region in
            let x0 = max(0, Int(region.minX * CGFloat(width)))
            let x1 = min(width - 1, Int(region.maxX * CGFloat(width)))
            let y0 = max(0, Int((1 - region.maxY) * CGFloat(height)))
            let y1 = min(height - 1, Int((1 - region.minY) * CGFloat(height)))
            return (0..<motionGridSize * motionGridSize).map { index in
                let gridY = index / motionGridSize
                let gridX = index % motionGridSize
                let x = min(x1, x0 + Int((Double(gridX) + 0.5) * Double(max(1, x1 - x0)) / Double(motionGridSize)))
                let y = min(y1, y0 + Int((Double(gridY) + 0.5) * Double(max(1, y1 - y0)) / Double(motionGridSize)))
                let offset = y * bytesPerRow + x * 4
                return 0.114 * Double(pointer[offset]) + 0.587 * Double(pointer[offset + 1]) + 0.299 * Double(pointer[offset + 2])
            }
        }
    }

    private static func verticalOpticalFlow(previous: [Double], current: [Double]) -> Double? {
        guard previous.count == current.count else { return nil }
        var numerator = 0.0
        var denominator = 0.0
        for y in 1..<(motionGridSize - 1) {
            for x in 1..<(motionGridSize - 1) {
                let index = y * motionGridSize + x
                let gradient = (current[index + motionGridSize] - current[index - motionGridSize]) / 2
                numerator += gradient * (current[index] - previous[index])
                denominator += gradient * gradient
            }
        }
        guard denominator >= 700 else { return nil }
        return max(-1.5, min(1.5, -numerator / denominator))
    }

    private static func averageRegionColours(
        _ buffer: CVPixelBuffer,
        face: VNFaceObservation
    ) -> [RGBValue] {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let baseAddress = CVPixelBufferGetBaseAddress(buffer) else { return [] }

        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        let box = face.boundingBox
        let regions = [
            CGRect(
                x: box.minX + box.width * 0.25,
                y: box.minY + box.height * 0.70,
                width: box.width * 0.50,
                height: box.height * 0.16
            ),
            CGRect(
                x: box.minX + box.width * 0.12,
                y: box.minY + box.height * 0.31,
                width: box.width * 0.25,
                height: box.height * 0.18
            ),
            CGRect(
                x: box.minX + box.width * 0.63,
                y: box.minY + box.height * 0.31,
                width: box.width * 0.25,
                height: box.height * 0.18
            ),
        ]

        let pointer = baseAddress.assumingMemoryBound(to: UInt8.self)
        return regions.compactMap { region in
            let x0 = max(0, Int(region.minX * CGFloat(width)))
            let x1 = min(width, Int(region.maxX * CGFloat(width)))
            let y0 = max(0, Int((1 - region.maxY) * CGFloat(height)))
            let y1 = min(height, Int((1 - region.minY) * CGFloat(height)))
            guard x1 > x0, y1 > y0 else { return nil }

            var red = 0.0
            var green = 0.0
            var blue = 0.0
            var count = 0.0
            for y in stride(from: y0, to: y1, by: 3) {
                for x in stride(from: x0, to: x1, by: 3) {
                    let offset = y * bytesPerRow + x * 4
                    blue += Double(pointer[offset])
                    green += Double(pointer[offset + 1])
                    red += Double(pointer[offset + 2])
                    count += 1
                }
            }
            guard count > 20 else { return nil }
            return RGBValue(red: red / count, green: green / count, blue: blue / count)
        }
    }
}

@MainActor
final class CameraPulseMonitor: ObservableObject {
    private static let initialCalibrationSeconds = 15.0
    private static let analysisWindowSeconds = 20.0
    private static let finalMeasurementSeconds = 60.0

    @Published var bpm: Double?
    @Published var respiratoryRate: Double?
    @Published var respirationStatus = "Move back until your shoulders and upper chest are visible"
    @Published var status = "Ready to measure"
    @Published var isMonitoring = false
    @Published var calibrationRemaining: Int?
    @Published var measurementSeconds = 0
    @Published var measurementComplete = false
    @Published var signalQuality: Double?
    @Published var faceBox: CGRect?
    @Published var bodyRegions: [CGRect] = []
    @Published var videoFrameSize = CGSize(width: 3, height: 4)
    @Published var cameras: [CameraOption] = []
    @Published var selectedCameraID = ""
    @Published var developerMode = false
    @Published var greenWaveform: [Double] = []

    let session = AVCaptureSession()

    private struct TimedSample {
        var time: Double
        var rgb: RGBValue
    }

    private struct TimedMotionSample {
        var time: Double
        var value: Double
    }

    private struct Estimate {
        let bpm: Double
        let quality: Double
    }

    private let processor = CameraFrameProcessor()
    private let videoQueue = DispatchQueue(label: "pulse-window-video", qos: .userInitiated)
    private var regionSamples: [[TimedSample]] = [[], [], []]
    private var recordingRegionSamples: [[TimedSample]] = [[], [], []]
    private var respirationSamples: [[TimedMotionSample]] = [[], [], []]
    private var candidates: [Double] = []
    private var pendingJump: [Double] = []
    private var lastEstimateTime = 0.0
    private var lastBodyMotionTime = 0.0
    private var smoothedFace: CGRect?
    private var faceLastSeen = 0.0
    private var pauseStarted: Double?
    private var pauseUntil = 0.0
    private var colourOffsets = [RGBValue.zero, RGBValue.zero, RGBValue.zero]
    private var greenBaseline: Double?
    private var configuredDeviceID = ""
    private var acceptedMeasurementDuration = 0.0
    private var lastAcceptedFrameTime: Double?
    private var finalResultConfirmed = false
    private var finalRespiratoryEvaluated = false
    private var respiratoryConfirmationStarted: Double?

    init() {
        processor.onResult = { [weak self] result in
            Task { @MainActor in self?.handle(result) }
        }
        refreshCameras()
        requestCameraPermission()
    }

    var selectedCamera: CameraOption? {
        cameras.first { $0.id == selectedCameraID }
    }

    var isFrontCamera: Bool {
        selectedCamera?.position != .back
    }

    func refreshCameras() {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [
                .builtInWideAngleCamera,
                .builtInUltraWideCamera,
                .builtInTelephotoCamera,
            ],
            mediaType: .video,
            position: .unspecified
        )
        let options = discovery.devices.map {
            CameraOption(id: $0.uniqueID, name: $0.localizedName, position: $0.position)
        }
        cameras = options
        if !options.contains(where: { $0.id == selectedCameraID }) {
            selectedCameraID = options.first(where: { $0.position == .front })?.id
                ?? options.first?.id
                ?? ""
        }
    }

    func requestCameraPermission() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                Task { @MainActor in
                    guard let self else { return }
                    if granted { self.configureSession() }
                    else { self.status = "Camera permission is required" }
                }
            }
        default:
            status = "Enable camera access in Settings"
        }
    }

    func selectCamera(_ id: String) {
        selectedCameraID = id
        configureSession()
    }

    func start() {
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
            requestCameraPermission()
            return
        }
        if configuredDeviceID != selectedCameraID { configureSession() }
        resetSignal()
        isMonitoring = true
        status = "Finding your face…"
        let captureSession = session
        DispatchQueue.global(qos: .userInitiated).async {
            if !captureSession.isRunning { captureSession.startRunning() }
        }
    }

    func stop() {
        isMonitoring = false
        calibrationRemaining = nil
        status = "Monitoring stopped"
    }

    func stopSession() {
        stop()
        let captureSession = session
        DispatchQueue.global(qos: .userInitiated).async {
            if captureSession.isRunning { captureSession.stopRunning() }
        }
    }

    func toggleDeveloperMode() {
        developerMode.toggle()
        greenWaveform.removeAll()
        greenBaseline = nil
    }

    private func configureSession() {
        guard !selectedCameraID.isEmpty,
              let device = AVCaptureDevice(uniqueID: selectedCameraID),
              let input = try? AVCaptureDeviceInput(device: device)
        else {
            status = cameras.isEmpty ? "No camera was found" : "Selected camera is unavailable"
            return
        }

        let wasRunning = session.isRunning
        if wasRunning { session.stopRunning() }
        session.beginConfiguration()
        session.sessionPreset = .medium
        session.inputs.forEach(session.removeInput)
        session.outputs.forEach(session.removeOutput)

        guard session.canAddInput(input) else {
            session.commitConfiguration()
            status = "Selected camera is unavailable"
            return
        }
        session.addInput(input)

        do {
            try device.lockForConfiguration()
            defer { device.unlockForConfiguration() }
            if device.activeFormat.videoSupportedFrameRateRanges.contains(where: {
                $0.minFrameRate <= 30 && $0.maxFrameRate >= 30
            }) {
                let frameDuration = CMTime(value: 1, timescale: 30)
                device.activeVideoMinFrameDuration = frameDuration
                device.activeVideoMaxFrameDuration = frameDuration
            }
        } catch {
            // Continue with the camera's default rate if it cannot be configured.
        }

        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        ]
        output.setSampleBufferDelegate(processor, queue: videoQueue)
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            status = "Camera frames are unavailable"
            return
        }
        session.addOutput(output)
        // The front and rear sensors have opposite native landscape
        // orientations. Using 90 degrees for the front camera makes Vision's
        // coordinates rotate 180 degrees away from the visible preview.
        let rotationAngle: CGFloat = device.position == .front ? 270 : 90
        if let connection = output.connection(with: .video),
           connection.isVideoRotationAngleSupported(rotationAngle) {
            connection.videoRotationAngle = rotationAngle
        }
        session.commitConfiguration()
        configuredDeviceID = selectedCameraID
        status = "Ready to measure"

        if wasRunning || isMonitoring {
            let captureSession = session
            DispatchQueue.global(qos: .userInitiated).async { captureSession.startRunning() }
        }
    }

    private func resetSignal(keepBPM: Bool = false) {
        regionSamples = [[], [], []]
        recordingRegionSamples = [[], [], []]
        respirationSamples = [[], [], []]
        candidates.removeAll()
        pendingJump.removeAll()
        lastEstimateTime = 0
        lastBodyMotionTime = 0
        smoothedFace = nil
        faceLastSeen = 0
        pauseStarted = nil
        pauseUntil = 0
        colourOffsets = [RGBValue.zero, RGBValue.zero, RGBValue.zero]
        calibrationRemaining = Int(Self.initialCalibrationSeconds)
        measurementSeconds = 0
        measurementComplete = false
        signalQuality = nil
        acceptedMeasurementDuration = 0
        lastAcceptedFrameTime = nil
        finalResultConfirmed = false
        finalRespiratoryEvaluated = false
        respiratoryConfirmationStarted = nil
        greenWaveform.removeAll()
        greenBaseline = nil
        bodyRegions = []
        respirationStatus = "Move back until your shoulders and upper chest are visible"
        if !keepBPM { bpm = nil; respiratoryRate = nil }
    }

    private func handle(_ result: CameraFrameResult) {
        guard isMonitoring else { return }
        videoFrameSize = result.frameSize

        guard let detectedFace = result.faceBox, result.regions.count == 3 else {
            lastAcceptedFrameTime = nil
            faceBox = nil
            pauseStarted = pauseStarted ?? result.timestamp
            if faceLastSeen > 0, result.timestamp - faceLastSeen > 5 {
                resetSignal()
            }
            status = "Paused — face not found; progress is saved"
            return
        }

        faceLastSeen = result.timestamp
        let centred = abs(detectedFace.midX - 0.5) <= 0.18
            && abs(detectedFace.midY - 0.5) <= 0.20
        let suitableSize = detectedFace.width >= 0.25
            && detectedFace.width <= 0.72
            && detectedFace.height >= 0.30
            && detectedFace.height <= 0.82
        guard !isFrontCamera || (centred && suitableSize) else {
            lastAcceptedFrameTime = nil
            faceBox = nil
            pauseStarted = pauseStarted ?? result.timestamp
            status = "Paused — centre your face inside the guide"
            return
        }

        if let previous = smoothedFace {
            let centreDistance = hypot(
                detectedFace.midX - previous.midX,
                detectedFace.midY - previous.midY
            ) / max(previous.width, 0.001)
            let sizeChange = abs(detectedFace.width - previous.width) / max(previous.width, 0.001)
            if centreDistance + sizeChange > 0.12 {
                pauseStarted = pauseStarted ?? result.timestamp
                pauseUntil = result.timestamp + 1.0
            }
            smoothedFace = CGRect(
                x: previous.minX + (detectedFace.minX - previous.minX) * 0.18,
                y: previous.minY + (detectedFace.minY - previous.minY) * 0.18,
                width: previous.width + (detectedFace.width - previous.width) * 0.18,
                height: previous.height + (detectedFace.height - previous.height) * 0.18
            )
        } else {
            smoothedFace = detectedFace
        }
        faceBox = smoothedFace

        let brightness = result.regions.reduce(0) {
            $0 + ($1.red + $1.green + $1.blue) / 3
        } / Double(result.regions.count)
        guard brightness >= 40, brightness <= 235 else {
            lastAcceptedFrameTime = nil
            pauseStarted = pauseStarted ?? result.timestamp
            status = brightness < 40
                ? "Paused — more light needed; progress is saved"
                : "Paused — too much light; progress is saved"
            return
        }
        guard result.timestamp >= pauseUntil else {
            lastAcceptedFrameTime = nil
            pauseStarted = pauseStarted ?? result.timestamp
            status = "Paused — movement detected; progress is saved"
            return
        }

        if let pauseStart = pauseStarted {
            let duration = result.timestamp - pauseStart
            regionSamples = regionSamples.map { region in
                region.map { TimedSample(time: $0.time + duration, rgb: $0.rgb) }
            }
            recordingRegionSamples = recordingRegionSamples.map { region in
                region.map { TimedSample(time: $0.time + duration, rgb: $0.rgb) }
            }
            respirationSamples = respirationSamples.map { region in
                region.map { TimedMotionSample(time: $0.time + duration, value: $0.value) }
            }
            colourOffsets = result.regions.enumerated().map { index, colour in
                guard let previous = regionSamples[index].last?.rgb else { return .zero }
                return RGBValue(
                    red: previous.red - colour.red,
                    green: previous.green - colour.green,
                    blue: previous.blue - colour.blue
                )
            }
            pauseStarted = nil
        }

        if let previousTime = lastAcceptedFrameTime {
            let frameDuration = result.timestamp - previousTime
            if frameDuration > 0, frameDuration < 0.5 {
                acceptedMeasurementDuration += frameDuration
            }
        }
        lastAcceptedFrameTime = result.timestamp
        measurementSeconds = min(Int(Self.finalMeasurementSeconds), Int(acceptedMeasurementDuration.rounded(.down)))
        measurementComplete = acceptedMeasurementDuration >= Self.finalMeasurementSeconds - 0.5

        let corrected = result.regions.enumerated().map { index, colour in
            RGBValue(
                red: colour.red + colourOffsets[index].red,
                green: colour.green + colourOffsets[index].green,
                blue: colour.blue + colourOffsets[index].blue
            )
        }
        for index in corrected.indices {
            regionSamples[index].append(TimedSample(time: result.timestamp, rgb: corrected[index]))
            regionSamples[index].removeAll {
                result.timestamp - $0.time > Self.analysisWindowSeconds + 0.5
            }
            recordingRegionSamples[index].append(TimedSample(time: result.timestamp, rgb: corrected[index]))
            recordingRegionSamples[index].removeAll {
                result.timestamp - $0.time > Self.finalMeasurementSeconds + 0.5
            }
        }
        bodyRegions = result.bodyRegions
        if result.bodyRegions.isEmpty {
            respirationStatus = "Move farther back so your shoulders and upper chest are visible"
        } else if let motion = result.bodyMotion, motion.count == 3 {
            if lastBodyMotionTime > 0, result.timestamp - lastBodyMotionTime > 2 {
                respirationSamples = [[], [], []]
                respiratoryRate = nil
            }
            lastBodyMotionTime = result.timestamp
            for index in motion.indices {
                respirationSamples[index].append(TimedMotionSample(time: result.timestamp, value: motion[index]))
                respirationSamples[index].removeAll { result.timestamp - $0.time > 60.5 }
            }
        }
        updateGreenWaveform(result.regions)

        guard let firstTime = regionSamples[0].first?.time else { return }
        let duration = result.timestamp - firstTime
        if duration < Self.initialCalibrationSeconds - 0.5 {
            calibrationRemaining = max(1, Int(ceil(Self.initialCalibrationSeconds - duration)))
            status = "Keep still while the signal builds"
            return
        }
        calibrationRemaining = nil
        guard result.timestamp - lastEstimateTime >= 1 else { return }
        lastEstimateTime = result.timestamp

        if !measurementComplete, !finalRespiratoryEvaluated, !result.bodyRegions.isEmpty {
            let breathingDuration = respirationSamples.map { region in
                guard let first = region.first, let last = region.last else { return 0.0 }
                return last.time - first.time
            }.max() ?? 0
            respirationStatus = breathingDuration < 25
                ? "Building breathing signal… \(max(1, Int(ceil(25 - breathingDuration)))) seconds"
                : "Tracking breathing movement · keep your upper body still"
        }

        if measurementComplete {
            if !finalRespiratoryEvaluated {
                respiratoryConfirmationStarted = respiratoryConfirmationStarted ?? result.timestamp
                if let breathing = Self.estimateFinalRespiratoryRate(respirationSamples) {
                    finalRespiratoryEvaluated = true
                    respiratoryRate = breathing.bpm
                    respirationStatus = "Breathing rate confirmed from agreeing chest regions"
                } else if result.timestamp - (respiratoryConfirmationStarted ?? result.timestamp) >= 12 {
                    finalRespiratoryEvaluated = true
                    respiratoryRate = nil
                    respirationStatus = "Unable to confirm breathing rate from this recording"
                } else {
                    respirationStatus = "Pulse complete · keep still while breathing rate is confirmed"
                }
            }
            if finalResultConfirmed {
                status = "Pulse confirmed from the full recording"
                return
            }
            guard let finalEstimate = Self.estimateFinalBPM(recordingRegionSamples) else {
                signalQuality = nil
                status = "60 seconds recorded · hold still while the final result is confirmed"
                return
            }
            bpm = finalEstimate.bpm
            signalQuality = finalEstimate.quality
            pendingJump.removeAll()
            finalResultConfirmed = true
            status = "Pulse confirmed from the full recording"
            return
        }

        let estimates = regionSamples.compactMap(Self.estimateBPM)
            .filter { $0.quality >= 0.18 }
        var estimate = Self.regionConsensus(estimates)
        if estimate?.quality ?? 0 < 0.30 { estimate = nil }
        var source = "regions"

        if estimate == nil,
           let combined = Self.estimateBPM(Self.combine(regionSamples)),
           combined.quality >= 0.22 {
            estimate = combined
            source = "combined face signal"
        }
        if estimate == nil, let strongest = estimates.max(by: { $0.quality < $1.quality }),
           strongest.quality >= 0.34 {
            estimate = strongest
            source = "clearest skin region"
        }
        guard let estimate else {
            signalQuality = nil
            status = "Signal weak — face steady front lighting"
            return
        }

        candidates.append(estimate.bpm)
        candidates = Array(candidates.suffix(7))
        let recent = Array(candidates.suffix(5))
        guard recent.count == 5, (recent.max()! - recent.min()!) <= 6 else {
            status = "Confirming (source)…"
            return
        }

        var stable = Self.median(recent)
        if let current = bpm, abs(stable - current) > 10 {
            pendingJump.append(stable)
            pendingJump = Array(pendingJump.suffix(6))
            guard pendingJump.count == 6,
                  (pendingJump.max()! - pendingJump.min()!) <= 6 else {
                status = "Checking a possible change…"
                return
            }
            stable = Self.median(pendingJump)
        } else {
            pendingJump.removeAll()
        }

        bpm = bpm.map { 0.85 * $0 + 0.15 * stable } ?? stable
        signalQuality = estimate.quality
        status = measurementComplete
            ? "Measurement complete · ready to save"
            : source == "regions" ? "Pulse found · keep still for the final result" : "Pulse found · \(source)"
    }

    private func updateGreenWaveform(_ colours: [RGBValue]) {
        guard developerMode else { return }
        let green = Self.median(colours.map(\.green))
        greenBaseline = greenBaseline.map { $0 * 0.96 + green * 0.04 } ?? green
        let delta = (green - (greenBaseline ?? green)) * 24
        greenWaveform.append(max(-40, min(40, delta)))
        greenWaveform = Array(greenWaveform.suffix(120))
    }

    private static func combine(_ regions: [[TimedSample]]) -> [TimedSample] {
        guard let count = regions.map(\.count).min(), count > 0 else { return [] }
        let starts = regions.map { $0.count - count }
        return (0..<count).map { index in
            let samples = regions.indices.map { regions[$0][starts[$0] + index] }
            return TimedSample(
                time: samples[0].time,
                rgb: RGBValue(
                    red: median(samples.map(\.rgb.red)),
                    green: median(samples.map(\.rgb.green)),
                    blue: median(samples.map(\.rgb.blue))
                )
            )
        }
    }

    private static func estimateRespiratoryRate(_ samples: [TimedMotionSample]) -> Estimate? {
        guard samples.count >= 150, let first = samples.first, let last = samples.last,
              last.time - first.time >= 25 else { return nil }
        let frameRate = 10.0
        let count = Int((last.time - first.time) * frameRate)
        guard count >= 250 else { return nil }
        var values = [Double]()
        var source = 0
        for index in 0..<count {
            let time = first.time + Double(index) / frameRate
            while source + 1 < samples.count, samples[source + 1].time < time { source += 1 }
            guard source + 1 < samples.count else { break }
            let a = samples[source], b = samples[source + 1]
            let fraction = (time - a.time) / max(b.time - a.time, 1e-6)
            values.append(a.value + (b.value - a.value) * fraction)
        }
        guard values.count >= 250 else { return nil }
        let slope = (values.last! - values.first!) / Double(max(1, values.count - 1))
        let signal = values.enumerated().map { $0.element - values[0] - slope * Double($0.offset) }
        var powers = [(rate: Double, power: Double)]()
        for rate in stride(from: 6.0, through: 30.0, by: 0.25) {
            var real = 0.0, imaginary = 0.0
            for (index, value) in signal.enumerated() {
                let hann = 0.5 - 0.5 * cos(2 * .pi * Double(index) / Double(max(1, signal.count - 1)))
                let angle = 2 * .pi * (rate / 60) * Double(index) / frameRate
                real += value * hann * cos(angle)
                imaginary -= value * hann * sin(angle)
            }
            powers.append((rate, real * real + imaginary * imaginary))
        }
        guard let peak = powers.max(by: { $0.power < $1.power }) else { return nil }
        let total = powers.reduce(0) { $0 + $1.power }
        let local = powers.filter { abs($0.rate - peak.rate) <= 2 }.reduce(0) { $0 + $1.power }
        let quality = total > 0 ? local / total : 0
        guard quality >= 0.17 else { return nil }
        return Estimate(bpm: peak.rate, quality: quality)
    }

    private static func respiratoryConsensus(_ estimates: [Estimate]) -> (rate: Double, quality: Double)? {
        var best: (rate: Double, quality: Double)?
        for first in estimates.indices {
            for second in estimates.indices where second > first {
                let a = estimates[first], b = estimates[second]
                guard abs(a.bpm - b.bpm) <= 3 else { continue }
                let quality = (a.quality + b.quality) / 2
                let rate = (a.bpm * a.quality + b.bpm * b.quality) / (a.quality + b.quality)
                if best == nil || quality > best!.quality { best = (rate, quality) }
            }
        }
        if let best { return best }
        guard let strongest = estimates.max(by: { $0.quality < $1.quality }), strongest.quality >= 0.3 else { return nil }
        return (strongest.bpm, strongest.quality)
    }

    private static func estimateFinalRespiratoryRate(_ regions: [[TimedMotionSample]]) -> Estimate? {
        let firstTimes = regions.compactMap { $0.first?.time }
        let lastTimes = regions.compactMap { $0.last?.time }
        guard regions.count == 3,
              let first = firstTimes.max(),
              let last = lastTimes.min(),
              last - first >= 42
        else { return nil }

        var estimates = [Estimate]()
        var start = first
        while start + 25 <= last + 0.25 {
            let end = start + 25
            let regional = regions.compactMap { samples in
                estimateRespiratoryRate(samples.filter { $0.time >= start && $0.time <= end })
            }
            if regional.count >= 2,
               let agreed = respiratoryConsensus(regional),
               agreed.quality >= 0.20 {
                estimates.append(Estimate(bpm: agreed.rate, quality: agreed.quality))
            }
            start += 8
        }

        guard estimates.count >= 3 else { return nil }
        let centre = median(estimates.map(\.bpm))
        let inliers = estimates.filter { abs($0.bpm - centre) <= 3 }
        guard inliers.count >= 3 else { return nil }
        let rates = inliers.map(\.bpm)
        guard let minimum = rates.min(), let maximum = rates.max(), maximum - minimum <= 4 else {
            return nil
        }
        let quality = inliers.map(\.quality).reduce(0, +) / Double(inliers.count)
        return Estimate(bpm: median(rates), quality: quality)
    }

    private static func regionConsensus(_ estimates: [Estimate]) -> Estimate? {
        var pairs = [(Estimate, Estimate)]()
        for first in estimates.indices {
            for second in estimates.indices where second > first {
                if abs(estimates[first].bpm - estimates[second].bpm) <= 10 {
                    pairs.append((estimates[first], estimates[second]))
                }
            }
        }
        guard let pair = pairs.max(by: {
            $0.0.quality + $0.1.quality < $1.0.quality + $1.1.quality
        }) else { return nil }
        let firstWeight = pair.0.quality * pair.0.quality
        let secondWeight = pair.1.quality * pair.1.quality
        return Estimate(
            bpm: (pair.0.bpm * firstWeight + pair.1.bpm * secondWeight) /
                (firstWeight + secondWeight),
            quality: (pair.0.quality + pair.1.quality) / 2
        )
    }

    // Build the saved result from overlapping windows across the complete
    // accepted recording, rather than allowing one short section to decide it.
    private static func estimateFinalBPM(_ regions: [[TimedSample]]) -> Estimate? {
        let firstTimes = regions.compactMap { $0.first?.time }
        let lastTimes = regions.compactMap { $0.last?.time }
        guard regions.count == 3,
              let first = firstTimes.max(),
              let last = lastTimes.min(),
              last - first >= 45
        else { return nil }

        var windowEstimates = [Estimate]()
        var start = first
        while start + analysisWindowSeconds <= last + 0.25 {
            let end = start + analysisWindowSeconds
            let windows = regions.map { region in
                region.filter { $0.time >= start && $0.time <= end }
            }
            let regional = windows.compactMap { estimateBPM($0) }.filter { $0.quality >= 0.18 }
            var estimate = regionConsensus(regional)
            if estimate == nil,
               let combinedEstimate = estimateBPM(combine(windows)),
               combinedEstimate.quality >= 0.22 {
                estimate = combinedEstimate
            }
            if let estimate, estimate.quality >= 0.30 { windowEstimates.append(estimate) }
            start += 10
        }

        guard windowEstimates.count >= 3 else { return nil }
        let centre = median(windowEstimates.map(\.bpm))
        let inliers = windowEstimates.filter { abs($0.bpm - centre) <= 6 }
        guard inliers.count >= 3 else { return nil }
        let rates = inliers.map(\.bpm)
        guard let minimum = rates.min(), let maximum = rates.max(), maximum - minimum <= 8 else {
            return nil
        }
        let meanQuality = inliers.map(\.quality).reduce(0, +) / Double(inliers.count)
        let consistency = max(0, 1 - (maximum - minimum) / 12)
        let quality = meanQuality * (0.65 + 0.35 * consistency)
        guard quality >= 0.30 else { return nil }
        return Estimate(bpm: median(rates), quality: quality)
    }

    private static func estimateBPM(_ samples: [TimedSample]) -> Estimate? {
        guard samples.count >= 200,
              let first = samples.first,
              let last = samples.last,
              last.time - first.time >= Self.initialCalibrationSeconds - 0.5
        else { return nil }

        let frameRate = 30.0
        let count = Int((last.time - first.time) * frameRate)
        guard count >= 400 else { return nil }
        var colours = [RGBValue]()
        colours.reserveCapacity(count)
        var source = 0
        for index in 0..<count {
            let time = first.time + Double(index) / frameRate
            while source + 1 < samples.count, samples[source + 1].time < time { source += 1 }
            guard source + 1 < samples.count else { break }
            let a = samples[source]
            let b = samples[source + 1]
            let fraction = (time - a.time) / max(b.time - a.time, 1e-6)
            colours.append(RGBValue(
                red: a.rgb.red + (b.rgb.red - a.rgb.red) * fraction,
                green: a.rgb.green + (b.rgb.green - a.rgb.green) * fraction,
                blue: a.rgb.blue + (b.rgb.blue - a.rgb.blue) * fraction
            ))
        }

        let window = Int(1.6 * frameRate)
        guard colours.count > window else { return nil }
        var pulse = Array(repeating: 0.0, count: colours.count)
        var weights = Array(repeating: 0.0, count: colours.count)
        for start in 0...(colours.count - window) {
            let segment = Array(colours[start..<(start + window)])
            let means = (0..<3).map { channel in
                segment.reduce(0) { $0 + $1[channel] } / Double(window)
            }
            var x = [Double]()
            var y = [Double]()
            for colour in segment {
                let red = colour.red / means[0] - 1
                let green = colour.green / means[1] - 1
                let blue = colour.blue / means[2] - 1
                x.append(green - blue)
                y.append(green + blue - 2 * red)
            }
            let alpha = standardDeviation(x) / max(standardDeviation(y), 1e-10)
            let projected = zip(x, y).map { $0 + alpha * $1 }
            let mean = projected.reduce(0, +) / Double(window)
            for offset in 0..<window {
                pulse[start + offset] += projected[offset] - mean
                weights[start + offset] += 1
            }
        }
        for index in pulse.indices where weights[index] > 0 { pulse[index] /= weights[index] }
        let mean = pulse.reduce(0, +) / Double(pulse.count)
        pulse = pulse.map { $0 - mean }

        var powers = [(bpm: Double, power: Double)]()
        for candidate in stride(from: 45.0, through: 180.0, by: 0.5) {
            let frequency = candidate / 60
            var real = 0.0
            var imaginary = 0.0
            for (index, value) in pulse.enumerated() {
                let angle = 2 * Double.pi * frequency * Double(index) / frameRate
                let hann = 0.5 - 0.5 * cos(2 * Double.pi * Double(index) /
                    Double(max(1, pulse.count - 1)))
                real += value * hann * cos(angle)
                imaginary -= value * hann * sin(angle)
            }
            powers.append((candidate, real * real + imaginary * imaginary))
        }
        guard var peak = powers.max(by: { $0.power < $1.power }) else { return nil }
        if peak.bpm >= 90,
           let half = powers.min(by: {
               abs($0.bpm - peak.bpm / 2) < abs($1.bpm - peak.bpm / 2)
           }), half.power >= peak.power * 0.65 {
            peak = half
        }
        let total = powers.reduce(0) { $0 + $1.power }
        let local = powers.filter { abs($0.bpm - peak.bpm) <= 9 }
            .reduce(0) { $0 + $1.power }
        return Estimate(bpm: peak.bpm, quality: total > 0 ? local / total : 0)
    }

    private static func standardDeviation(_ values: [Double]) -> Double {
        let mean = values.reduce(0, +) / Double(values.count)
        return sqrt(values.reduce(0) { $0 + pow($1 - mean, 2) } / Double(values.count))
    }

    private static func median(_ values: [Double]) -> Double {
        let sorted = values.sorted()
        return sorted[sorted.count / 2]
    }
}

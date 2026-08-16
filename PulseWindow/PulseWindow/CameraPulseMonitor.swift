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
}

final class CameraFrameProcessor: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    var onResult: (@Sendable (CameraFrameResult) -> Void)?

    private var frameNumber = 0
    private var lastFace: VNFaceObservation?
    private var lastFaceTimestamp = 0.0

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
            let request = VNDetectFaceRectanglesRequest()
            let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up)
            try? handler.perform([request])
            if let face = request.results?.max(by: {
                $0.boundingBox.width * $0.boundingBox.height <
                    $1.boundingBox.width * $1.boundingBox.height
            }) {
                lastFace = face
                lastFaceTimestamp = timestamp
            }
        }

        guard let face = lastFace, timestamp - lastFaceTimestamp <= 1.0 else {
            onResult?(CameraFrameResult(
                timestamp: timestamp,
                frameSize: frameSize,
                faceBox: nil,
                regions: []
            ))
            return
        }

        let colours = Self.averageRegionColours(pixelBuffer, face: face)
        onResult?(CameraFrameResult(
            timestamp: timestamp,
            frameSize: frameSize,
            faceBox: face.boundingBox,
            regions: colours
        ))
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

    @Published var bpm: Double?
    @Published var status = "Ready to measure"
    @Published var isMonitoring = false
    @Published var calibrationRemaining: Int?
    @Published var faceBox: CGRect?
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

    private struct Estimate {
        let bpm: Double
        let quality: Double
    }

    private let processor = CameraFrameProcessor()
    private let videoQueue = DispatchQueue(label: "pulse-window-video", qos: .userInitiated)
    private var regionSamples: [[TimedSample]] = [[], [], []]
    private var candidates: [Double] = []
    private var pendingJump: [Double] = []
    private var lastEstimateTime = 0.0
    private var smoothedFace: CGRect?
    private var faceLastSeen = 0.0
    private var pauseStarted: Double?
    private var pauseUntil = 0.0
    private var colourOffsets = [RGBValue.zero, RGBValue.zero, RGBValue.zero]
    private var greenBaseline: Double?
    private var configuredDeviceID = ""

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
        candidates.removeAll()
        pendingJump.removeAll()
        lastEstimateTime = 0
        smoothedFace = nil
        faceLastSeen = 0
        pauseStarted = nil
        pauseUntil = 0
        colourOffsets = [RGBValue.zero, RGBValue.zero, RGBValue.zero]
        calibrationRemaining = Int(Self.initialCalibrationSeconds)
        greenWaveform.removeAll()
        greenBaseline = nil
        if !keepBPM { bpm = nil }
    }

    private func handle(_ result: CameraFrameResult) {
        guard isMonitoring else { return }
        videoFrameSize = result.frameSize

        guard let detectedFace = result.faceBox, result.regions.count == 3 else {
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
            pauseStarted = pauseStarted ?? result.timestamp
            status = brightness < 40
                ? "Paused — more light needed; progress is saved"
                : "Paused — too much light; progress is saved"
            return
        }
        guard result.timestamp >= pauseUntil else {
            pauseStarted = pauseStarted ?? result.timestamp
            status = "Paused — movement detected; progress is saved"
            return
        }

        if let pauseStart = pauseStarted {
            let duration = result.timestamp - pauseStart
            regionSamples = regionSamples.map { region in
                region.map { TimedSample(time: $0.time + duration, rgb: $0.rgb) }
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
        status = source == "regions" ? "Live pulse estimate" : "Live estimate · (source)"
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

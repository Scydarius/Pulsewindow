import AVFoundation
import SwiftUI

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    let faceBox: CGRect?
    let mirrored: Bool
    let frameSize: CGSize

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        view.update(faceBox: faceBox, mirrored: mirrored, frameSize: frameSize)
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        if uiView.previewLayer.session !== session {
            uiView.previewLayer.session = session
        }
        uiView.update(faceBox: faceBox, mirrored: mirrored, frameSize: frameSize)
    }
}

final class PreviewView: UIView {
    private let faceLayer = CAShapeLayer()
    private let regionLayer = CAShapeLayer()
    private var currentFaceBox: CGRect?
    private var mirrored = false
    private var frameSize = CGSize(width: 3, height: 4)

    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

    var previewLayer: AVCaptureVideoPreviewLayer {
        layer as! AVCaptureVideoPreviewLayer
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        faceLayer.fillColor = UIColor.clear.cgColor
        faceLayer.strokeColor = UIColor.systemMint.cgColor
        faceLayer.lineWidth = 3
        regionLayer.fillColor = UIColor.clear.cgColor
        regionLayer.strokeColor = UIColor.systemYellow.cgColor
        regionLayer.lineWidth = 2
        previewLayer.addSublayer(faceLayer)
        previewLayer.addSublayer(regionLayer)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        drawTrackingOverlay()
    }

    func update(faceBox: CGRect?, mirrored: Bool, frameSize: CGSize) {
        currentFaceBox = faceBox
        self.mirrored = mirrored
        if frameSize.width > 0, frameSize.height > 0 {
            self.frameSize = frameSize
        }
        if let connection = previewLayer.connection {
            connection.automaticallyAdjustsVideoMirroring = false
            if connection.isVideoMirroringSupported {
                connection.isVideoMirrored = mirrored
            }
        }
        drawTrackingOverlay()
    }

    private func drawTrackingOverlay() {
        guard bounds.width > 0, bounds.height > 0 else { return }

        let shownFace: CGRect
        if mirrored {
            // The front camera uses a stable target that is easier to follow.
            let guideWidth = bounds.width * 0.62
            let guideHeight = min(bounds.height * 0.58, guideWidth * 1.12)
            shownFace = CGRect(
                x: (bounds.width - guideWidth) / 2,
                y: (bounds.height - guideHeight) / 2,
                width: guideWidth,
                height: guideHeight
            )
            faceLayer.strokeColor = currentFaceBox == nil
                ? UIColor.white.withAlphaComponent(0.82).cgColor
                : UIColor.systemMint.cgColor
        } else {
            // Rear cameras keep a genuinely moving tracker. Map Vision's
            // portrait-normalized rectangle directly through the preview's
            // aspect-fill crop; do not pass it through AVCapture's metadata
            // converter, which applies a second rotation on these frames.
            guard let box = currentFaceBox else {
                faceLayer.path = nil
                regionLayer.path = nil
                return
            }
            let scale = max(
                bounds.width / frameSize.width,
                bounds.height / frameSize.height
            )
            let displayedWidth = frameSize.width * scale
            let displayedHeight = frameSize.height * scale
            let offsetX = (bounds.width - displayedWidth) / 2
            let offsetY = (bounds.height - displayedHeight) / 2
            shownFace = CGRect(
                x: offsetX + box.minX * displayedWidth,
                y: offsetY + (1 - box.maxY) * displayedHeight,
                width: box.width * displayedWidth,
                height: box.height * displayedHeight
            )
            faceLayer.strokeColor = UIColor.systemMint.cgColor
        }
        faceLayer.path = UIBezierPath(
            roundedRect: shownFace,
            cornerRadius: max(16, shownFace.width * 0.18)
        ).cgPath

        // Position regions inside the displayed face rectangle so they remain
        // forehead/left cheek/right cheek in either camera mode.
        let regions = [
            CGRect(x: shownFace.minX + shownFace.width * 0.25,
                   y: shownFace.minY + shownFace.height * 0.14,
                   width: shownFace.width * 0.50,
                   height: shownFace.height * 0.16),
            CGRect(x: shownFace.minX + shownFace.width * 0.12,
                   y: shownFace.minY + shownFace.height * 0.51,
                   width: shownFace.width * 0.25,
                   height: shownFace.height * 0.18),
            CGRect(x: shownFace.minX + shownFace.width * 0.63,
                   y: shownFace.minY + shownFace.height * 0.51,
                   width: shownFace.width * 0.25,
                   height: shownFace.height * 0.18),
        ]
        let path = UIBezierPath()
        for region in regions {
            path.append(UIBezierPath(roundedRect: region, cornerRadius: 6))
        }
        regionLayer.path = path.cgPath
    }

}

struct FaceTrackingOverlay: View {
    let faceBox: CGRect?
    let mirrored: Bool

    var body: some View {
        GeometryReader { geometry in
            if let faceBox {
                let x = (mirrored ? 1 - faceBox.maxX : faceBox.minX) * geometry.size.width
                let y = (1 - faceBox.maxY) * geometry.size.height
                let width = faceBox.width * geometry.size.width
                let height = faceBox.height * geometry.size.height

                ZStack(alignment: .topLeading) {
                    RoundedRectangle(cornerRadius: max(16, width * 0.18))
                        .stroke(Color.mint, lineWidth: 3)
                        .frame(width: width, height: height)
                        .position(x: x + width / 2, y: y + height / 2)

                    ForEach(Array(regionRects(in: CGRect(x: x, y: y, width: width, height: height)).enumerated()), id: \.offset) { _, region in
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(Color.yellow.opacity(0.95), lineWidth: 2)
                            .frame(width: region.width, height: region.height)
                            .position(x: region.midX, y: region.midY)
                    }

                    Text("Face tracked")
                        .font(.caption.bold())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(.black.opacity(0.64), in: Capsule())
                        .position(x: x + width / 2, y: max(18, y - 18))
                }
            } else {
                RoundedRectangle(cornerRadius: 90)
                    .stroke(Color.white.opacity(0.8), style: StrokeStyle(lineWidth: 3, dash: [10, 8]))
                    .frame(width: geometry.size.width * 0.54, height: geometry.size.height * 0.72)
                    .position(x: geometry.size.width / 2, y: geometry.size.height / 2)
            }
        }
        .allowsHitTesting(false)
    }

    private func regionRects(in face: CGRect) -> [CGRect] {
        [
            CGRect(x: face.minX + face.width * 0.25, y: face.minY + face.height * 0.14,
                   width: face.width * 0.50, height: face.height * 0.16),
            CGRect(x: face.minX + face.width * 0.12, y: face.minY + face.height * 0.51,
                   width: face.width * 0.25, height: face.height * 0.18),
            CGRect(x: face.minX + face.width * 0.63, y: face.minY + face.height * 0.51,
                   width: face.width * 0.25, height: face.height * 0.18),
        ]
    }
}

struct GreenWaveformView: View {
    let samples: [Double]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("Amplified green change", systemImage: "waveform.path.ecg")
                    .font(.caption.bold())
                Spacer()
                Text("24×")
                    .font(.caption.monospacedDigit().bold())
            }
            Canvas { context, size in
                let middle = size.height / 2
                var centre = Path()
                centre.move(to: CGPoint(x: 0, y: middle))
                centre.addLine(to: CGPoint(x: size.width, y: middle))
                context.stroke(centre, with: .color(.white.opacity(0.22)), lineWidth: 1)

                guard samples.count > 1 else { return }
                var path = Path()
                for (index, sample) in samples.enumerated() {
                    let x = CGFloat(index) / CGFloat(samples.count - 1) * size.width
                    let y = middle - CGFloat(sample / 40) * middle * 0.88
                    if index == 0 { path.move(to: CGPoint(x: x, y: y)) }
                    else { path.addLine(to: CGPoint(x: x, y: y)) }
                }
                context.stroke(path, with: .color(.green), lineWidth: 2)
            }
            .frame(height: 76)
            Text("Movement and lighting changes are amplified too.")
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.72))
        }
        .foregroundStyle(.white)
        .padding(14)
        .background(.black.opacity(0.72), in: RoundedRectangle(cornerRadius: 16))
    }
}

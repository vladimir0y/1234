import ARKit
import Combine
import RealityKit

/// Drives an ARKit LiDAR scene-reconstruction session and keeps the latest mesh anchors.
@MainActor
final class BodyScanner: NSObject, ObservableObject, ARSessionDelegate {
    enum Phase: Equatable { case idle, scanning, exporting, uploading, failed(String) }

    static var isSupported: Bool {
        ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification)
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var triangleCount = 0
    @Published private(set) var trackingHint: String = "Наведіть камеру на людину"
    /// Keep geometry within this horizontal radius around the subject (metres).
    @Published var cropRadius: Float = 0.6

    let arView = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
    private var anchors: [UUID: ARMeshAnchor] = [:]
    private var subjectCenter: SIMD3<Float>?

    override init() {
        super.init()
        arView.session.delegate = self
        arView.environment.sceneUnderstanding.options = []
        arView.debugOptions.insert(.showSceneUnderstanding)
        arView.renderOptions.insert(.disableMotionBlur)
    }

    func start() {
        guard Self.isSupported else {
            phase = .failed("Цей пристрій не має LiDAR")
            return
        }
        let config = ARWorldTrackingConfiguration()
        config.sceneReconstruction = .meshWithClassification
        config.environmentTexturing = .none
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
            config.frameSemantics.insert(.smoothedSceneDepth)
        }
        anchors.removeAll()
        subjectCenter = nil
        triangleCount = 0
        arView.session.run(config, options: [.resetTracking, .removeExistingAnchors])
        phase = .scanning
    }

    func pause() {
        arView.session.pause()
    }

    /// Mark the person: raycast from the screen centre to find where they stand.
    func lockSubject() {
        let center = CGPoint(x: arView.bounds.midX, y: arView.bounds.midY)
        if let hit = arView.raycast(from: center, allowing: .estimatedPlane, alignment: .any).first {
            let t = hit.worldTransform.columns.3
            subjectCenter = SIMD3(t.x, t.y, t.z)
            trackingHint = "Обійдіть людину повільно по колу, тримаючи телефон на рівні тіла"
        }
    }

    var hasSubject: Bool { subjectCenter != nil }

    /// Writes the cleaned mesh as OBJ to a temp file.
    func exportOBJ() throws -> URL {
        phase = .exporting
        let exporter = MeshExporter(
            anchors: Array(anchors.values),
            subjectCenter: subjectCenter,
            cropRadius: cropRadius
        )
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("tutu-scan-\(Int(Date().timeIntervalSince1970)).obj")
        try exporter.writeOBJ(to: url)
        return url
    }

    func setPhase(_ phase: Phase) { self.phase = phase }

    // MARK: ARSessionDelegate

    nonisolated func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        Task { @MainActor in self.update(anchors) }
    }

    nonisolated func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        Task { @MainActor in self.update(anchors) }
    }

    nonisolated func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        Task { @MainActor in
            for a in anchors { self.anchors.removeValue(forKey: a.identifier) }
            self.recount()
        }
    }

    nonisolated func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        let hint: String
        switch camera.trackingState {
        case .normal: hint = "Добре. Продовжуйте обхід"
        case .limited(.excessiveMotion): hint = "Повільніше"
        case .limited(.insufficientFeatures): hint = "Замало деталей — додайте світла"
        case .limited(.initializing), .limited(.relocalizing): hint = "Ініціалізація…"
        case .notAvailable: hint = "Трекінг недоступний"
        default: hint = "Обмежений трекінг"
        }
        Task { @MainActor in self.trackingHint = hint }
    }

    private func update(_ list: [ARAnchor]) {
        for case let mesh as ARMeshAnchor in list { anchors[mesh.identifier] = mesh }
        recount()
    }

    private func recount() {
        triangleCount = anchors.values.reduce(0) { $0 + $1.geometry.faces.count }
    }
}

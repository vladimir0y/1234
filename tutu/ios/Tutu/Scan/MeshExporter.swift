import ARKit
import simd

/// Converts ARKit mesh anchors into a single welded OBJ in world space (metres, Y up).
/// Removes floor / walls / furniture using LiDAR classification and keeps only
/// geometry inside a vertical cylinder around the subject.
struct MeshExporter {
    let anchors: [ARMeshAnchor]
    let subjectCenter: SIMD3<Float>?
    let cropRadius: Float

    /// Weld tolerance: vertices closer than this are merged (seams between anchors).
    private let weld: Float = 0.0005

    private static let dropped: Set<ARMeshClassification> = [.floor, .wall, .ceiling, .table, .seat, .window, .door]

    func writeOBJ(to url: URL) throws {
        var positions: [SIMD3<Float>] = []
        var faces: [SIMD3<UInt32>] = []
        var lookup: [SIMD3<Int32>: UInt32] = [:]

        func index(for p: SIMD3<Float>) -> UInt32 {
            let key = SIMD3<Int32>(Int32((p.x / weld).rounded()), Int32((p.y / weld).rounded()), Int32((p.z / weld).rounded()))
            if let i = lookup[key] { return i }
            let i = UInt32(positions.count)
            positions.append(p)
            lookup[key] = i
            return i
        }

        for anchor in anchors {
            let g = anchor.geometry
            let world = anchor.transform
            let vertexBase = g.vertices.buffer.contents()
            let faceBase = g.faces.buffer.contents()
            let bytesPerIndex = g.faces.bytesPerIndex

            func vertex(_ i: Int) -> SIMD3<Float> {
                let p = vertexBase.advanced(by: g.vertices.offset + g.vertices.stride * i).assumingMemoryBound(to: Float.self)
                let w = world * SIMD4<Float>(p[0], p[1], p[2], 1)
                return SIMD3(w.x, w.y, w.z)
            }

            func faceIndex(_ f: Int, _ k: Int) -> Int {
                let ptr = faceBase.advanced(by: (f * 3 + k) * bytesPerIndex)
                return bytesPerIndex == 4
                    ? Int(ptr.assumingMemoryBound(to: UInt32.self).pointee)
                    : Int(ptr.assumingMemoryBound(to: UInt16.self).pointee)
            }

            func classification(_ f: Int) -> ARMeshClassification {
                guard let c = g.classification else { return .none }
                let raw = c.buffer.contents().advanced(by: c.offset + c.stride * f).assumingMemoryBound(to: UInt8.self).pointee
                return ARMeshClassification(rawValue: Int(raw)) ?? .none
            }

            for f in 0..<g.faces.count {
                if Self.dropped.contains(classification(f)) { continue }
                let a = vertex(faceIndex(f, 0))
                let b = vertex(faceIndex(f, 1))
                let c = vertex(faceIndex(f, 2))
                if let center = subjectCenter {
                    let centroid = (a + b + c) / 3
                    let d = SIMD2(centroid.x - center.x, centroid.z - center.z)
                    if simd_length(d) > cropRadius { continue }
                }
                let ia = index(for: a), ib = index(for: b), ic = index(for: c)
                if ia == ib || ib == ic || ia == ic { continue }
                faces.append(SIMD3(ia, ib, ic))
            }
        }

        guard !faces.isEmpty else {
            throw NSError(domain: "Tutu", code: 1, userInfo: [NSLocalizedDescriptionKey: "Скан порожній — підійдіть ближче і обійдіть людину"])
        }

        var obj = "# Tutu LiDAR scan, metres, Y up\n"
        obj.reserveCapacity(positions.count * 32 + faces.count * 24)
        for p in positions { obj += "v \(p.x) \(p.y) \(p.z)\n" }
        for f in faces { obj += "f \(f.x + 1) \(f.y + 1) \(f.z + 1)\n" }
        try obj.write(to: url, atomically: true, encoding: .utf8)
    }
}

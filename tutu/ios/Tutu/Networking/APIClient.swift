import Foundation

struct ScanMeta: Codable, Identifiable {
    let id: String
    let name: String
    let format: String
    let bytes: Int
    let created_at: Double
}

struct APIClient {
    let baseURL: URL

    func listScans() async throws -> [ScanMeta] {
        let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: "api/scans"))
        try Self.check(response, data)
        return try JSONDecoder().decode([ScanMeta].self, from: data)
    }

    /// Multipart upload of a mesh file (OBJ from the scanner).
    func uploadScan(fileURL: URL, name: String) async throws -> ScanMeta {
        let boundary = "tutu-\(UUID().uuidString)"
        var request = URLRequest(url: baseURL.appending(path: "api/scans"))
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        func append(_ string: String) { body.append(string.data(using: .utf8)!) }
        append("--\(boundary)\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\n\(name)\r\n")
        append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(fileURL.lastPathComponent)\"\r\n")
        append("Content-Type: application/octet-stream\r\n\r\n")
        body.append(try Data(contentsOf: fileURL))
        append("\r\n--\(boundary)--\r\n")

        let (data, response) = try await URLSession.shared.upload(for: request, from: body)
        try Self.check(response, data)
        return try JSONDecoder().decode(ScanMeta.self, from: data)
    }

    func editorURL(scanID: String?) -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        if let scanID { components.queryItems = [URLQueryItem(name: "scan", value: scanID)] }
        return components.url!
    }

    private static func check(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw NSError(domain: "Tutu", code: (response as? HTTPURLResponse)?.statusCode ?? -1,
                          userInfo: [NSLocalizedDescriptionKey: "Помилка сервера: \(text.prefix(200))"])
        }
    }
}

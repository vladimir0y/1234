import SwiftUI
import WebKit

/// Hosts the shared web editor. The same editor runs in the browser and here,
/// so features ship once for iOS, iPad and desktop.
struct EditorScreen: View {
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.dismiss) private var dismiss
    let scanID: String?
    @State private var sharedFile: URL?

    var body: some View {
        NavigationStack {
            Group {
                if let api = settings.api {
                    EditorWebView(url: api.editorURL(scanID: scanID)) { file in sharedFile = file }
                        .ignoresSafeArea(edges: .bottom)
                } else {
                    ContentUnavailableView("Невірна адреса сервера", systemImage: "network.slash")
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Готово") { dismiss() }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
        }
        .sheet(item: Binding(get: { sharedFile.map(ShareItem.init) }, set: { sharedFile = $0?.url })) { item in
            ShareSheet(items: [item.url])
        }
    }
}

struct EditorWebView: UIViewRepresentable {
    let url: URL
    /// Files exported by the editor (stencils, screenshots) arrive here.
    let onFile: (URL) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onFile: onFile) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "tutu")
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(Color.tutuBackground)
        web.scrollView.isScrollEnabled = false
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler {
        let onFile: (URL) -> Void
        init(onFile: @escaping (URL) -> Void) { self.onFile = onFile }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  body["type"] as? String == "file",
                  let filename = body["filename"] as? String,
                  let dataURL = body["dataURL"] as? String,
                  let comma = dataURL.firstIndex(of: ","),
                  let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...]))
            else { return }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
            do {
                try data.write(to: url)
                onFile(url)
            } catch {
                print("Tutu: failed to save \(filename): \(error)")
            }
        }
    }
}

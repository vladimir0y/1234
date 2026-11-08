import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var settings: AppSettings
    @State private var showScanner = false
    @State private var editorScanID: String?
    @State private var scans: [ScanMeta] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        showScanner = true
                    } label: {
                        Label("Нове сканування", systemImage: "camera.metering.matrix")
                            .font(.headline)
                    }
                    if !BodyScanner.isSupported {
                        Text("Для сканування потрібен iPhone/iPad з LiDAR (моделі Pro). Можна відкрити редактор з демо-моделлю.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Button {
                        editorScanID = ""
                    } label: {
                        Label("Редактор з демо-моделлю", systemImage: "paintbrush.pointed")
                    }
                }

                Section("Мої скани") {
                    if scans.isEmpty {
                        Text("Поки порожньо").foregroundStyle(.secondary)
                    }
                    ForEach(scans) { scan in
                        Button {
                            editorScanID = scan.id
                        } label: {
                            VStack(alignment: .leading) {
                                Text(scan.name)
                                Text(ByteCountFormatter.string(fromByteCount: Int64(scan.bytes), countStyle: .file))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                Section("Сервер") {
                    TextField("http://адреса:8000", text: $settings.serverURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if let error {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Tutu")
            .refreshable { await loadScans() }
            .task { await loadScans() }
            .fullScreenCover(isPresented: $showScanner) {
                ScanView { scanID in
                    showScanner = false
                    Task { await loadScans() }
                    editorScanID = scanID
                }
            }
            .fullScreenCover(item: Binding(
                get: { editorScanID.map(EditorTarget.init) },
                set: { editorScanID = $0?.id }
            )) { target in
                EditorScreen(scanID: target.id.isEmpty ? nil : target.id)
            }
        }
    }

    private func loadScans() async {
        guard let api = settings.api else { return }
        do {
            scans = try await api.listScans()
            error = nil
        } catch {
            self.error = "Сервер недоступний: \(error.localizedDescription)"
        }
    }
}

private struct EditorTarget: Identifiable {
    let id: String
}

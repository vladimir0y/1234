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
                        editorScanID = ""
                    } label: {
                        Label("Почати з базового тіла", systemImage: "figure.stand")
                            .font(.headline)
                    }
                    Text("5 чоловічих і 5 жіночих статур, зріст налаштовується. Скан не потрібен.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Додатково: власний скан") {
                    if BodyScanner.isSupported {
                        Button {
                            showScanner = true
                        } label: {
                            Label("LiDAR-сканування тіла", systemImage: "camera.metering.matrix")
                        }
                    } else {
                        Label("Потрібен iPhone/iPad з LiDAR (моделі Pro)", systemImage: "camera.metering.unknown")
                            .foregroundStyle(.secondary)
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

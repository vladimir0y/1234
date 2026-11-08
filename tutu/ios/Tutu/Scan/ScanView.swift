import RealityKit
import SwiftUI

struct ScanView: View {
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.dismiss) private var dismiss
    @StateObject private var scanner = BodyScanner()
    @State private var name = "Скан \(Date().formatted(date: .abbreviated, time: .shortened))"
    @State private var exportedFile: URL?

    /// Called with the uploaded scan id.
    let onFinished: (String) -> Void

    var body: some View {
        ZStack {
            ARViewContainer(arView: scanner.arView).ignoresSafeArea()

            if !scanner.hasSubject, scanner.phase == .scanning {
                Image(systemName: "plus.viewfinder")
                    .font(.system(size: 54, weight: .thin))
                    .foregroundStyle(.white.opacity(0.85))
            }

            VStack {
                HStack {
                    Button("Закрити") {
                        scanner.pause()
                        dismiss()
                    }
                    .buttonStyle(.bordered)
                    Spacer()
                    Text("\(scanner.triangleCount.formatted()) △")
                        .font(.callout.monospacedDigit())
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(.ultraThinMaterial, in: Capsule())
                }
                .padding()

                Text(statusText)
                    .font(.callout)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))

                Spacer()

                controls
                    .padding()
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))
                    .padding()
            }
        }
        .onAppear { scanner.start() }
        .onDisappear { scanner.pause() }
        .sheet(item: Binding(get: { exportedFile.map(ShareItem.init) }, set: { exportedFile = $0?.url })) { item in
            ShareSheet(items: [item.url])
        }
    }

    @ViewBuilder private var controls: some View {
        VStack(spacing: 12) {
            if scanner.hasSubject {
                HStack {
                    Text("Радіус обрізки")
                    Slider(value: $scanner.cropRadius, in: 0.3...1.2)
                    Text("\(Int(scanner.cropRadius * 100)) см").monospacedDigit()
                }
                .font(.footnote)
            }
            HStack(spacing: 12) {
                if !scanner.hasSubject {
                    Button {
                        scanner.lockSubject()
                    } label: {
                        Label("Це людина", systemImage: "person.fill.viewfinder").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                } else {
                    Button("Заново") { scanner.start() }
                        .buttonStyle(.bordered)
                    Button {
                        Task { await finish() }
                    } label: {
                        Label(isBusy ? "Обробка…" : "Готово", systemImage: "checkmark").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isBusy || scanner.triangleCount == 0)
                }
            }
        }
    }

    private var isBusy: Bool { scanner.phase == .exporting || scanner.phase == .uploading }

    private var statusText: String {
        switch scanner.phase {
        case .idle: return "Підготовка…"
        case .scanning:
            return scanner.hasSubject
                ? scanner.trackingHint
                : "Наведіть приціл на людину, що стоїть нерухомо, і натисніть «Це людина»"
        case .exporting: return "Очищаю і зберігаю модель…"
        case .uploading: return "Завантажую на сервер…"
        case .failed(let message): return message
        }
    }

    private func finish() async {
        do {
            let file = try scanner.exportOBJ()
            scanner.pause()
            guard let api = settings.api else {
                exportedFile = file
                return
            }
            scanner.setPhase(.uploading)
            do {
                let meta = try await api.uploadScan(fileURL: file, name: name)
                onFinished(meta.id)
            } catch {
                // Server unreachable: let the user keep the file.
                scanner.setPhase(.failed("Сервер недоступний. Збережіть OBJ і відкрийте у веб-редакторі."))
                exportedFile = file
            }
        } catch {
            scanner.setPhase(.failed(error.localizedDescription))
        }
    }
}

private struct ARViewContainer: UIViewRepresentable {
    let arView: ARView
    func makeUIView(context: Context) -> ARView { arView }
    func updateUIView(_ uiView: ARView, context: Context) {}
}

struct ShareItem: Identifiable {
    let url: URL
    var id: URL { url }
}

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

import SwiftUI

@main
struct TutuApp: App {
    @StateObject private var settings = AppSettings()

    var body: some Scene {
        WindowGroup {
            HomeView()
                .environmentObject(settings)
                .preferredColorScheme(.dark)
                .tint(Color.tutuAccent)
        }
    }
}

final class AppSettings: ObservableObject {
    /// Base URL of the Tutu backend, e.g. http://192.168.1.20:8000 during development.
    @AppStorage("serverURL") var serverURL: String = "http://192.168.1.20:8000"

    var api: APIClient? {
        guard let url = URL(string: serverURL) else { return nil }
        return APIClient(baseURL: url)
    }
}

extension Color {
    static let tutuAccent = Color(red: 0.25, green: 0.82, blue: 0.79)
    static let tutuBackground = Color(red: 0.07, green: 0.07, blue: 0.09)
}

import SwiftUI
import MWDATCore

@main
struct BearlyApp: App {
  @StateObject private var model = Model()

  init() {
    // Must run once before anything else touches the glasses SDK.
    do { try Wearables.configure() } catch { NSLog("[glasses] configure failed: \(error)") }
  }

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environmentObject(model)
        // The Meta AI app comes back here after registration and after the camera permission screen.
        .onOpenURL { url in Task { _ = try? await Wearables.shared.handleUrl(url) } }
    }
  }
}

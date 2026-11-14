import SwiftUI
import UIKit

/// One screen: where the stage is, a preview of what the glasses see, and one button.
@MainActor
final class Model: ObservableObject {
  @Published var stage = UserDefaults.standard.string(forKey: "stage") ?? "http://localhost:3127"
  @Published var status = "Not connected"
  @Published var preview: UIImage?
  /// While sending, the screen stays on so the phone keeps streaming in a pocket. Carry it screen side in.
  @Published var running = false { didSet { UIApplication.shared.isIdleTimerDisabled = running } }
  @Published var frames = 0

  private let glasses = Glasses()
  private let publisher = Publisher()
  private let phone = PhoneTracker()
  private let head = HeadTracker()
  private var sensorTimer: Timer?
  @Published var sensors = "sensors: waiting"
  @Published var headFlipped = false { didSet { head.flipped = headFlipped } }
  private var justRecentered = false

  @Published var log: [String] = []

  /// Shows a status line, keeps the last few, and sends it to the stage Mac so it can be read there.
  private func note(_ text: String) {
    status = text
    log = Array((log + [text]).suffix(8))
    NSLog("[bearly] \(text)")
    guard let url = URL(string: "\(stage.trimmingCharacters(in: .whitespaces))/api/twin/log") else { return }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["from": "phone", "text": text, "frames": frames])
    request.timeoutInterval = 3
    URLSession.shared.dataTask(with: request).resume()
  }

  init() {
    glasses.onStatus = { [weak self] text in self?.note(text) }
    publisher.onStatus = { [weak self] text in self?.note(text) }
    glasses.onMotion = { [weak self] sample in self?.head.feed(sample) }
    startSensors()
    glasses.onFrame = { [weak self] image in
      guard let self else { return }
      frames += 1
      if frames % 3 == 0 { preview = image } // the preview does not need every frame
      publisher.push(image)
    }
  }

  /// Stand where the demo starts, face the way you will walk, then press this. Position and both directions go to zero.
  func recenter() { phone.recenter(); head.recenter(); justRecentered = true; note("Recentered. This spot and this direction are now zero.") }

  /// Ten times a second: where the phone says the body is, and how far the glasses say the head is turned from the body.
  private func startSensors() {
    phone.start()
    sensorTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self else { return }
        self.sensors = String(format: "steps %d · x %.1f m, z %.1f m · body %.0f° · head %@", self.phone.steps, self.phone.x, self.phone.z, self.phone.heading * 180 / .pi, self.head.samples > 0 ? String(format: "%.0f°", (self.head.yaw - self.phone.heading) * 180 / .pi) : "no glasses motion")
        guard self.running else { return }
        self.publisher.send(["type": "pose", "x": self.phone.x, "z": self.phone.z, "heading": self.phone.heading, "steps": self.phone.steps, "reset": self.justRecentered])
        self.justRecentered = false
        if self.head.samples > 0 { self.publisher.send(["type": "imu", "yaw": self.head.yaw - self.phone.heading, "pitch": 0]) }
      }
    }
  }

  @Published var glassesOff = false

  func register() { Task { await glasses.register() } }

  /// The glasses camera connects by itself when the app opens and stays on. It is not tied to the Start button.
  func connectGlasses(force: Bool = false) {
    if force { glassesOff = false }
    guard !glassesOff else { return } // stopped by hand: stays off until Reconnect
    Task { await glasses.start(force: force) }
  }

  /// Ends the glasses session so another app (or another try) can have the glasses. Sending to the stage stops too.
  func stopSession() {
    glassesOff = true
    glasses.stop()
    preview = nil
    Task {
      if running { await publisher.disconnect(); running = false }
      note("Glasses session stopped. Tap Reconnect glasses to start again.")
    }
  }

  /// Start and Stop only decide whether the picture and the mic are sent to the stage.
  func toggle() {
    Task {
      if running {
        await publisher.disconnect()
        running = false; note("Stopped sending. The glasses stay connected.")
      } else {
        UserDefaults.standard.set(stage, forKey: "stage")
        running = true
        await publisher.connect(stage: stage.trimmingCharacters(in: .whitespaces))
        if !glasses.live { glassesOff = false; await glasses.start() }
      }
    }
  }
}

struct ContentView: View {
  @EnvironmentObject var model: Model
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Bearly").font(.largeTitle.bold())
      Text(model.status).font(.callout).lineLimit(3)
      VStack(alignment: .leading, spacing: 2) {
        ForEach(Array(model.log.dropLast().suffix(4).enumerated()), id: \.offset) { _, line in
          Text(line).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
      }

      ZStack {
        Color.black
        if let image = model.preview {
          Image(uiImage: image).resizable().scaledToFit()
        } else {
          Text("The glasses view shows here").foregroundStyle(.gray)
        }
      }
      .frame(maxWidth: .infinity).aspectRatio(3 / 4, contentMode: .fit)
      .clipShape(RoundedRectangle(cornerRadius: 16))

      TextField("Stage address", text: $model.stage)
        .textFieldStyle(.roundedBorder).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
        .disabled(model.running)

      Button(action: model.toggle) {
        Text(model.running ? "Stop sending" : "Send to stage").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 14)
      }
      .buttonStyle(.borderedProminent).tint(model.running ? .gray : .white).foregroundStyle(.black)

      Text(model.sensors).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
      HStack {
        Button("Recenter here", action: model.recenter).font(.footnote.bold())
        Toggle("Flip head", isOn: $model.headFlipped).font(.footnote).fixedSize()
        Spacer()
      }
      HStack {
        Button("Register with Meta AI", action: model.register).font(.footnote)
        Button("Reconnect glasses") { model.connectGlasses(force: true) }.font(.footnote)
        Button("Stop session", role: .destructive) { model.stopSession() }.font(.footnote).disabled(model.glassesOff)
        Spacer()
        Text("\(model.frames) frames").font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
      }
    }
    .padding(20)
    .preferredColorScheme(.dark)
    .task { try? await Task.sleep(nanoseconds: 1_500_000_000); model.connectGlasses() }
    .onChange(of: scenePhase) { _, phase in if phase == .active { model.connectGlasses() } }
  }
}

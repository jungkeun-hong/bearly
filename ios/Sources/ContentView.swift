import SwiftUI
import UIKit
import AVFoundation

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
  /// The Vexo band (mic + taps), forwarded to the Mac over the room. Number printed on the band.
  private let band = VexoBand()
  private let bandNumber = 67
  @Published var bandLine = "Band: off"
  private var sensorTimer: Timer?
  @Published var sensors = "sensors: waiting"
  private var justRecentered = false

  @Published var log: [String] = []

  /// Shows a status line, keeps the last few, and sends it to the stage Mac so it can be read there.
  private func note(_ text: String) {
    status = text
    log = Array((log + [text]).suffix(8))
    NSLog("[vibeglasses] \(text)")
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
    // The glasses sometimes end a running session by themselves (often right after the mic switches to them).
    // Bring the camera back on its own after the 7 s the glasses need to accept a new session. Up to 3 times in a row.
    glasses.onLost = { [weak self] in
      guard let self, self.running, !self.glassesOff, self.recoveries < 1 else { return } // one try only: Carbyn caps re-attaches, hammering refusing glasses keeps them stuck
      self.recoveries += 1
      self.note("The glasses dropped the camera. Reconnecting in 7 s (\(self.recoveries) of 3)…")
      Task { try? await Task.sleep(nanoseconds: 7_000_000_000); guard self.running else { return }; await self.glasses.start(force: true); if self.glasses.live { self.recoveries = 0 } }
    }
    publisher.onStatus = { [weak self] text in self?.note(text) }
    // Any change of the phone's sound route is logged: a hands-free (HFP) link to the glasses makes them refuse the camera.
    NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
      Task { @MainActor in self?.note("audio route changed: \(Publisher.routeText())") }
    }
    // Band callbacks come on the band's Bluetooth queue: hop to the main actor (the publisher lives there).
    band.onNote = { [weak self] text in Task { @MainActor in self?.bandLine = text; self?.note(text) } }
    band.onState = { [weak self] state, why in
      Task { @MainActor in
        guard let self else { return }
        self.bandLine = "Band: \(state) · \(why)"; self.note(self.bandLine)
        self.sendJSON(["type": "band-status", "state": state, "note": why])
      }
    }
    band.onTap = { [weak self] kind in Task { @MainActor in self?.sendJSON(["type": "band", "kind": kind]) } }
    band.onAudio = { [weak self] seq, opus in
      var payload = Data([UInt8(seq >> 8), UInt8(seq & 0xff)]) // 2 bytes seq, big-endian, then the raw Opus packet
      payload.append(opus)
      Task { @MainActor in self?.publisher.sendBinary(payload, topic: "band-audio", reliable: false) }
    }
    startSensors()
    glasses.onFrame = { [weak self] image in
      guard let self else { return }
      frames += 1
      if let image { preview = image } // the preview does not need every frame
      publisher.framesFlowing()
    }
  }

  /// Reliable JSON to the room (band taps and band status).
  private func sendJSON(_ message: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    publisher.sendBinary(data, topic: nil, reliable: true)
  }

  /// Stand where the demo starts, face the way you will walk, then press this. Position and both directions go to zero.
  func recenter() { phone.recenter(); justRecentered = true; note("Recentered. This spot and this direction are now zero.") }

  /// Ten times a second: where the phone says the body is (steps and heading).
  private func startSensors() {
    phone.start()
    sensorTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self else { return }
        self.sensors = String(format: "steps %d · x %.1f m, z %.1f m · body %.0f°", self.phone.steps, self.phone.x, self.phone.z, self.phone.heading * 180 / .pi)
        guard self.running else { return }
        self.publisher.send(["type": "pose", "x": self.phone.x, "z": self.phone.z, "heading": self.phone.heading, "steps": self.phone.steps, "reset": self.justRecentered])
        self.justRecentered = false
      }
    }
  }

  @Published var glassesOff = false
  @Published var glassesMic = UserDefaults.standard.bool(forKey: "glassesMic") { didSet { UserDefaults.standard.set(glassesMic, forKey: "glassesMic") } }
  private var recoveries = 0

  /// Hold to talk: while the big button is held, the stage listens. Letting go ends the sentence.
  /// The glasses mic keeps streaming the whole time; this only tells the stage when to pay attention.
  @Published var talking = false
  func talk(_ down: Bool) {
    guard talking != down else { return }
    talking = down
    publisher.send(["type": "ptt", "down": down])
    if down { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
  }
  /// Back to hands-free listening on the stage.
  func handsFree() { talking = false; publisher.send(["type": "pttmode", "on": false]); note("Hands-free listening") }

  func register() { Task { await glasses.register() } }

  /// Start is the only way the glasses connect, Stop the only way they disconnect. Nothing connects on launch.
  /// Start: voice first (room, mic, Bluetooth route), camera last, as in the Carbyn app.
  /// Stop: the stage stops getting anything and the glasses session ends, so the glasses are free again.
  private var lastStop = Date.distantPast
  func toggle() {
    Task {
      if running {
        running = false; glassesOff = true; recoveries = 0
        for _ in 0..<3 { publisher.send(["type": "stop"]); try? await Task.sleep(nanoseconds: 150_000_000) } // the stage stops listening
        await glasses.stop(); preview = nil
        await band.stop() // streams off on the band, then let it go, before the room closes
        await publisher.disconnect()
        lastStop = Date()
        note("Stopped. The glasses are disconnected.")
      } else {
        UserDefaults.standard.set(stage, forKey: "stage")
        running = true; glassesOff = false; recoveries = 0
        await publisher.connect(stage: stage.trimmingCharacters(in: .whitespaces), glassesMic: glassesMic)
        publisher.send(["type": "pttmode", "on": false]) // the stage listens hands-free (the Vexo band is the mic now)
        // Start on the phone starts the stage too: the Mac connects the band mic and turns the assistant on.
        // Messages are lossy, so it is said three times; the stage ignores repeats.
        for _ in 0..<3 { publisher.send(["type": "start"]); try? await Task.sleep(nanoseconds: 300_000_000) }
        // The glasses refuse a new session for about 7 s after one ends.
        let wait = 7 - Date().timeIntervalSince(lastStop)
        if wait > 0 { note("Waiting \(Int(wait.rounded(.up))) s for the glasses to be ready…"); try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
        guard running else { return } // Stop pressed while waiting
        await glasses.start(force: true)
        // The band comes after the glasses attach (streaming or refused), so its Bluetooth scan does not run during the attach.
        // The band is on the Mac's Bluetooth again: on the phone it shared Bluetooth with the glasses and both dropped data.
      }
    }
  }
}

struct ContentView: View {
  @EnvironmentObject var model: Model
  @State private var more = false

  var body: some View {
    VStack(spacing: 16) {
      // What the glasses see, with one status line on top of it.
      ZStack(alignment: .top) {
        Color.black
        if let image = model.preview { Image(uiImage: image).resizable().scaledToFit() }
        else { Text(model.running ? "Waiting for the glasses camera…" : "Put the glasses on, then Start").foregroundStyle(.gray).frame(maxHeight: .infinity) }
        Text(model.status).font(.footnote).lineLimit(2).padding(.horizontal, 12).padding(.vertical, 8)
          .frame(maxWidth: .infinity, alignment: .leading).background(.black.opacity(0.55))
      }
      .frame(maxWidth: .infinity).frame(maxHeight: .infinity)
      .clipShape(RoundedRectangle(cornerRadius: 20))

      Button(action: model.toggle) {
        Text(model.running ? "Stop" : "Start").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 14)
      }
      .buttonStyle(.borderedProminent).tint(model.running ? .gray : .white).foregroundStyle(.black)

      Button(more ? "Hide settings" : "Settings") { more.toggle() }.font(.footnote).foregroundStyle(.secondary)
      if more {
        VStack(alignment: .leading, spacing: 10) {
          TextField("Stage address", text: $model.stage)
            .textFieldStyle(.roundedBorder).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
            .disabled(model.running)
          Button("Recenter here", action: model.recenter)
          Button("Register glasses (first time only)", action: model.register).disabled(model.running)
          Text(model.bandLine).font(.caption2).foregroundStyle(.secondary)
          Text("\(model.frames) frames · \(model.sensors)").font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
        }
        .font(.footnote)
      }
    }
    .padding(20)
    .preferredColorScheme(.dark)
    // The camera is not started on launch: it starts with Start, after the mic, as in the Carbyn app.
  }
}

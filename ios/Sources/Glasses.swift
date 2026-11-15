import Foundation
import UIKit
import MWDATCore
import MWDATCamera

/// The Meta glasses: register this app with them, then stream their camera as UIImages.
/// The sequence and the waits follow what the Carbyn app learned the hard way with DAT 1.0.1
/// (mobile/src/services/vision/adapters/meta/GlassesSource.ts):
///   registered -> a connected device -> camera permission -> session reaches .started -> add camera -> stream reaches .streaming.
/// Each failed attempt tears the session down and tries again from scratch with a lighter stream.
@MainActor
final class Glasses {
  var onFrame: ((UIImage?) -> Void)?
  var onStatus: ((String) -> Void)?
  /// Called when the glasses end a session that was streaming (not when we stop it ourselves).
  var onLost: (() -> Void)?

  private var session: DeviceSession?
  private var camera: Camera?
  private var tokens: [AnyListenerToken] = []
  private var keep: [AnyListenerToken] = [] // registration and device listeners, for the life of the app
  private var registration: RegistrationState = .unavailable
  private var devices: [DeviceIdentifier] = []
  private var sessionState: DeviceSessionState = .idle
  private var streamState: StreamState = .stopped
  private var gotFrame = false
  private var sessionError: DeviceSessionError?
  private var run = 0 // bumped by stop(), so an attempt that is still waiting gives up

  init() {
    keep.append(Wearables.shared.addRegistrationStateListener { [weak self] state in
      Task { @MainActor in self?.registration = state; self?.onStatus?("registration: \(Self.name(state))") }
    })
    keep.append(Wearables.shared.addDevicesListener { [weak self] list in
      Task { @MainActor in self?.devices = list; self?.onStatus?("glasses known to this app: \(list.count)") }
    })
  }

  /// Opens the Meta AI app once so the user can allow this app. Comes back through onOpenURL.
  func register() async {
    do { try await Wearables.shared.startRegistration() } catch { onStatus?("registration failed: \(error.localizedDescription)") }
  }

  /// True while frames are arriving.
  var live: Bool { camera != nil && gotFrame }
  private var starting = false

  /// Connects the camera once and leaves it on. Calling it again while it is live or still trying does nothing.
  /// A connection attempt already running is never interrupted by another one: restarting in the middle tears down
  /// a session that may be seconds away from streaming.
  func start(force: Bool = false) async {
    if starting { onStatus?("still connecting, one moment…"); return }
    if !force && live { return }
    await stop()
    starting = true
    defer { starting = false }
    let mine = run
    do {
      // 1. Registered with the Meta AI app. The state can read "unavailable" for a moment after launch.
      guard await wait(3, mine, { self.registration == .registered }) else {
        onStatus?("Not registered (\(Self.name(registration))). Tap Register with Meta AI, allow, then Start again."); return
      }
      // 2. A pair of glasses that is actually connected right now. Paired is not the same as connected.
      onStatus?("looking for connected glasses…")
      guard await wait(12, mine, { self.connectedDevice() != nil }), let deviceId = connectedDevice() else {
        onStatus?("No connected glasses (\(describeDevices())). Unfold and wear them, open the Meta AI app once, check Developer Mode, then Start again."); return
      }
      onStatus?("found \(describeDevices())")
      if let device = Wearables.shared.deviceForIdentifier(deviceId), device.compatibility() != .compatible, device.compatibility() != .undefined {
        onStatus?("These glasses need an update: \(device.compatibility().displayString)"); return
      }
      // 3. Camera permission. Asking for it jumps to the Meta AI app and back, so only ask when it is not already granted.
      //    Without this check every app launch bounced through Meta AI before the camera came on.
      var permission = (try? await Wearables.shared.checkPermissionStatus(.camera)) ?? .denied
      if permission != .granted { permission = try await Wearables.shared.requestPermission(.camera) }
      guard permission == .granted else { onStatus?("Camera permission was not granted in the Meta AI app."); return }

      // 4. Attach ladder: every attempt is a brand new session, with a lighter stream each time.
      let ladder: [(StreamingResolution, UInt)] = [(.high, 7), (.high, 15), (.medium, 15)] // full picture quality, fewer frames: 7 a second is enough for the AI and the stage; 24 overloaded the link after ~2 min
      for (index, step) in ladder.enumerated() {
        guard mine == run else { return }
        onStatus?("attempt \(index + 1) of \(ladder.count): \(step.0) at \(step.1) fps")
        if try await attach(deviceId, resolution: step.0, fps: step.1, mine) { onStatus?("glasses camera is streaming"); return }
        await teardownAndWait()
        // The glasses refused outright (Carbyn GlassesSource.ts: once the device stops a session, do not keep asking;
        // hammering refusing glasses with new sessions is what leaves them stuck). Stop and say what to check.
        if let e = sessionError {
          onStatus?("The glasses refused (\(e)). Something else holds their camera: another app or phone, or a call or Live AI in Meta AI. Put them in the case for 30 s, then Start again.")
          return
        }
        try await Task.sleep(nanoseconds: 1_500_000_000) // Carbyn's retry gap
      }
      onStatus?("refused · \(describeDevices())")
      onStatus?("The glasses refused. WEAR them (unfolded), then in the Meta AI app open Developer Mode for these glasses and push the settings to the glasses again. Then tap Reconnect glasses.")
    } catch {
      onStatus?("could not start: \(String(describing: error))")
    }
  }

  private func attach(_ deviceId: DeviceIdentifier, resolution: StreamingResolution, fps: UInt, _ mine: Int) async throws -> Bool {
    sessionState = .idle; streamState = .stopped; gotFrame = false; sessionError = nil
    // Name the device. A brand new AutoDeviceSelector has not picked one yet, and createSession then fails with noEligibleDevice.
    let session: DeviceSession
    do { session = try Wearables.shared.createSession(deviceSelector: SpecificDeviceSelector(device: deviceId)) }
    catch { onStatus?("could not open a session: \(error)"); return false }
    self.session = session
    tokens.append(session.statePublisher.listen { [weak self] state in
      Task { @MainActor in
        guard let self else { return }
        self.sessionState = state; self.onStatus?("session: \(state)")
        if state == .stopped && self.gotFrame && self.session === session { self.gotFrame = false; Task { await self.teardownAndWait(); self.onLost?() } }
      }
    })
    tokens.append(session.errorPublisher.listen { [weak self] error in
      Task { @MainActor in self?.sessionError = error; self?.onStatus?("session error: \(error)") }
    })
    try session.start()
    // A camera can only be added once the session reports .started. On a weak link that takes well over 2 s.
    guard await wait(10, mine, { self.sessionState == .started || session.state == .started || self.sessionError != nil }), sessionError == nil else {
      onStatus?("session did not start (\(sessionState))"); return false
    }
    guard let camera = try session.addCamera(config: StreamConfiguration(videoCodec: .raw, resolution: resolution, frameRate: fps)) else {
      onStatus?("the glasses gave no camera"); return false
    }
    self.camera = camera
    let stream = camera.stream
    // Every frame goes straight to LiveKit as it arrives. Only every sixth one is turned into a picture for the phone screen.
    var count = 0
    tokens.append(stream.videoFramePublisher.listen { [weak self] frame in
      FrameSink.shared.push(frame.sampleBuffer)
      count += 1
      let image = count % 6 == 0 ? frame.makeUIImage() : nil
      Task { @MainActor in self?.gotFrame = true; self?.onFrame?(image) }
    })
    tokens.append(stream.statePublisher.listen { [weak self] state in
      Task { @MainActor in self?.streamState = state; self?.onStatus?("camera: \(state)") }
    })
    tokens.append(stream.errorPublisher.listen { [weak self] error in
      Task { @MainActor in self?.onStatus?("camera error: \(error)") }
    })
    stream.start()
    // "starting" that never becomes "streaming" is the classic stuck state: frames are the proof.
    // No glasses Motion here: it is a beta capability, the Carbyn app never adds it, and adding it to a streaming session
    // is the most likely reason the camera ran a few seconds and then "Session ended by device".
    return await wait(20, mine, { self.gotFrame })
  }

  private func connectedDevice() -> DeviceIdentifier? {
    let list = devices.isEmpty ? Wearables.shared.devices : devices
    return list.first { Wearables.shared.deviceForIdentifier($0)?.linkState == .connected }
  }

  private func describeDevices() -> String {
    let list = devices.isEmpty ? Wearables.shared.devices : devices
    if list.isEmpty { return "no glasses listed" }
    return list.map { id in
      guard let d = Wearables.shared.deviceForIdentifier(id) else { return "unknown" }
      if d.linkState != .connected { return "\(d.nameOrId()): \(d.linkState)" }
      // What the glasses say about themselves: worn or not, hinges, heat, battery. Any of these can make them refuse a session.
      let battery = d.batteryLevel.map { "\($0)%" } ?? "?"
      return "\(d.nameOrId()): connected · worn: \(d.donState) · hinge: \(d.hingeState) · heat: \(d.thermalLevel) · battery: \(battery) \(d.chargingState)"
    }.joined(separator: " | ")
  }

  /// Polls a condition until it holds, the time is up, or this attempt was cancelled.
  private func wait(_ seconds: Double, _ mine: Int, _ done: @escaping () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
      if mine != run { return false }
      if done() { return true }
      try? await Task.sleep(nanoseconds: 200_000_000)
    }
    return done()
  }

  /// Camera first, then the session, and wait until the session really reports stopped (up to 3 s) before anything new
  /// starts. A session dropped without waiting can leave a phantom camera on the glasses that refuses every later session
  /// (Carbyn GlassesSource.ts, meta-wearables-dat-ios#231).
  private func teardownAndWait() async {
    gotFrame = false
    camera?.stop(); camera = nil
    if let s = session {
      s.stop()
      let end = Date().addingTimeInterval(3)
      while s.state != .stopped && Date() < end { try? await Task.sleep(nanoseconds: 100_000_000) }
    }
    tokens.removeAll(); session = nil
  }

  func stop() async { run += 1; await teardownAndWait() }

  private static func name(_ state: RegistrationState) -> String {
    switch state {
    case .unavailable: return "unavailable"
    case .available: return "available, not registered"
    case .registering: return "registering"
    case .registered: return "registered"
    @unknown default: return "unknown"
    }
  }
}

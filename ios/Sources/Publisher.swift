import Foundation
import UIKit
import AVFoundation
import LiveKit

/// Hands each glasses frame to LiveKit on the glasses' own thread: no hop to the main thread and no
/// image redraw on the way, which is what made the picture lag before.
final class FrameSink: @unchecked Sendable {
  static let shared = FrameSink()
  private let lock = NSLock()
  private var capturer: BufferCapturer?
  func set(_ c: BufferCapturer?) { lock.lock(); capturer = c; lock.unlock() }
  func push(_ sample: CMSampleBuffer) { lock.lock(); let c = capturer; lock.unlock(); c?.capture(sample) }
}

/// The LiveKit room: publishes the glasses frames as a video track and the microphone as an audio track.
@MainActor
final class Publisher {
  var onStatus: ((String) -> Void)?

  private let room = Room()
  private var track: LocalVideoTrack?
  private var capturer: BufferCapturer?
  private var published = false
  private var publishing = false
  private(set) var connected = false

  /// Gets a publish-only token from the stage Mac and joins the room with the microphone on.
  func connect(stage: String, glassesMic: Bool = false) async {
    do {
      // Ask the stage Mac for a fresh pass. If the Mac cannot be reached (another network, cellular), reuse the last one:
      // it is good for twelve hours, so once fetched the phone can reconnect from anywhere with internet.
      var answer = await fetchPass(stage: stage)
      let fresh = answer != nil
      if let got = answer, got.token != nil, let data = try? JSONEncoder().encode(got) {
        UserDefaults.standard.set(data, forKey: "pass"); UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "passAt")
      } else if Date().timeIntervalSince1970 - UserDefaults.standard.double(forKey: "passAt") < 11 * 3600,
                let data = UserDefaults.standard.data(forKey: "pass") {
        answer = try? JSONDecoder().decode(TokenAnswer.self, from: data)
      }
      guard let answer, let server = answer.url, let token = answer.token else {
        onStatus?("Cannot reach the stage Mac and there is no saved pass. Join the Mac's Wi-Fi once and try again."); return
      }
      if !fresh { onStatus?("stage Mac not reachable, using the saved pass") }

      // NO microphone and NO Bluetooth call audio on this phone. The glasses are also this phone's Bluetooth headset, and
      // LiveKit's default audio setup (play-and-record with hands-free allowed) opens a hands-free (HFP) link to them as
      // soon as a mic is published. Meta (meta-wearables-dat-ios#342): while that link is up the glasses refuse every new
      // session with "Device unavailable" and end running ones. The wearer's voice comes from the Vexo band instead.
      AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = false
      try? AVAudioSession.sharedInstance().setCategory(.ambient, mode: .default, options: [])
      try await room.connect(url: server, token: token)
      connected = true
      let track = await LocalVideoTrack.createBufferTrack(name: "glasses-camera", source: .camera)
      self.track = track
      capturer = track.capturer as? BufferCapturer
      FrameSink.shared.set(capturer)
      onStatus?("in room \(answer.room ?? "?") · no phone mic · audio route: \(Self.routeText())")
    } catch {
      onStatus?("room failed: \(error.localizedDescription)")
    }
  }

  /// Called after frames have gone into the capturer (FrameSink, straight from the glasses thread).
  /// The video track is published once the first frame has gone in, because LiveKit reads the video size from it.
  func framesFlowing() {
    guard connected else { return }
    if let capturer { FrameSink.shared.set(capturer) }
    if !published, !publishing, let track {
      publishing = true
      Task {
        do {
          // One full-quality layer (no simulcast), so the Mac never gets a small backup copy, and keep the
          // resolution sharp when bandwidth dips (drop frames instead), because the AI reads labels from it.
          try await room.localParticipant.publish(videoTrack: track, options: VideoPublishOptions(
            encoding: VideoEncoding(maxBitrate: 2_500_000, maxFps: 15), simulcast: false, degradationPreference: .maintainResolution))
          published = true
          onStatus?("live · camera is in the room")
        } catch {
          onStatus?("could not publish video: \(error.localizedDescription)")
        }
        publishing = false
      }
    }
  }

  /// One small sensor message to everyone in the room (the stage page). Lossy on purpose: the next one is 100 ms away.
  func send(_ message: [String: Any]) {
    guard connected, let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    Task { try? await room.localParticipant.publish(data: data, options: DataPublishOptions(reliable: false)) }
  }

  /// Raw bytes to everyone in the room. `topic` nil = no topic (like send()). Reliable for events, lossy for audio.
  func sendBinary(_ data: Data, topic: String?, reliable: Bool) {
    guard connected else { return }
    Task { try? await room.localParticipant.publish(data: data, options: DataPublishOptions(topic: topic, reliable: reliable)) }
  }

  func disconnect() async {
    FrameSink.shared.set(nil)
    await room.disconnect()
    connected = false; published = false; track = nil; capturer = nil
  }

  /// What iOS is using for sound right now. "BluetoothHFP" here means a call-audio link to the glasses is up.
  static func routeText() -> String {
    let r = AVAudioSession.sharedInstance().currentRoute
    let name = { (p: AVAudioSessionPortDescription) in "\(p.portType.rawValue)" }
    return "in [\(r.inputs.map(name).joined(separator: ","))] out [\(r.outputs.map(name).joined(separator: ","))]"
  }

  private func fetchPass(stage: String) async -> TokenAnswer? {
    guard let url = URL(string: "\(stage)/api/twin/livekit-token?role=glasses") else { return nil }
    var request = URLRequest(url: url)
    request.timeoutInterval = 4
    guard let (data, _) = try? await URLSession.shared.data(for: request) else { return nil }
    return try? JSONDecoder().decode(TokenAnswer.self, from: data)
  }

  private struct TokenAnswer: Codable { let url: String?; let token: String?; let room: String?; let error: String? }
}

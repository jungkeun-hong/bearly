import Foundation
import UIKit
import AVFoundation
import LiveKit

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
  func connect(stage: String) async {
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

      try await room.connect(url: server, token: token)
      connected = true
      // Audio session after connecting: changing it earlier stalled WebRTC in an earlier app.
      routeMicToGlasses()
      try await room.localParticipant.setMicrophone(enabled: true)

      let track = await LocalVideoTrack.createBufferTrack(name: "glasses-camera", source: .camera)
      self.track = track
      capturer = track.capturer as? BufferCapturer
      onStatus?("in room \(answer.room ?? "?") · mic on · waiting for camera frames")
    } catch {
      onStatus?("room failed: \(error.localizedDescription)")
    }
  }

  /// Push one glasses frame. The video track is published once the first frame has gone in,
  /// because LiveKit reads the video size from it.
  func push(_ image: UIImage) {
    guard connected, let capturer, let cg = image.cgImage,
          let buffer = Self.pixelBuffer(from: cg) else { return }
    capturer.capture(buffer)
    if !published, !publishing, let track {
      publishing = true
      Task {
        do {
          try await room.localParticipant.publish(videoTrack: track, options: VideoPublishOptions(encoding: VideoEncoding(maxBitrate: 3_000_000, maxFps: 24)))
          published = true
          onStatus?("live · camera and mic are in the room")
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

  func disconnect() async {
    await room.disconnect()
    connected = false; published = false; track = nil; capturer = nil
  }

  /// The glasses microphone is the phone's Bluetooth hands-free input. Prefer it when it is there.
  private func routeMicToGlasses() {
    let audio = AVAudioSession.sharedInstance()
    try? audio.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .allowBluetoothA2DP])
    try? audio.setActive(true)
    if let input = audio.availableInputs?.first(where: { let n = $0.portName.lowercased(); return n.contains("meta") || n.contains("ray-ban") || n.contains("oakley") }) {
      try? audio.setPreferredInput(input)
    }
  }

  /// BGRA pixel buffer at the image's own size, capped at 1280 on the long side.
  private static func pixelBuffer(from image: CGImage) -> CVPixelBuffer? {
    let scale = min(1, 1280 / CGFloat(max(image.width, image.height)))
    let width = Int(CGFloat(image.width) * scale) / 2 * 2, height = Int(CGFloat(image.height) * scale) / 2 * 2
    var out: CVPixelBuffer?
    let attrs: [CFString: Any] = [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true, kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
    guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &out) == kCVReturnSuccess, let buffer = out else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height, bitsPerComponent: 8,
                                  bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return buffer
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

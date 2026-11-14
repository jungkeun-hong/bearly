import Foundation
import CoreMotion
import MWDATMotion
import simd

/// Where the wearer is and which way their body faces, from this phone in a pocket. No camera, no GPS:
/// steps are counted from the bounce of walking, direction comes from the compass-referenced attitude.
/// Position is a walked path in metres from the spot where Recenter was pressed. It drifts over minutes.
@MainActor
final class PhoneTracker {
  private let motion = CMMotionManager()
  private(set) var x = 0.0, z = 0.0, steps = 0
  private(set) var heading = 0.0 // radians, clockwise, 0 = the way the body faced at Recenter
  private var rawHeading = 0.0, heading0: Double?
  private var bounce = 0.0, armed = true, lastStep = 0.0
  var stepLength = 0.7

  var available: Bool { motion.isDeviceMotionAvailable }

  func start() {
    guard motion.isDeviceMotionAvailable, !motion.isDeviceMotionActive else { return }
    motion.deviceMotionUpdateInterval = 1.0 / 50
    motion.startDeviceMotionUpdates(using: .xMagneticNorthZVertical, to: .main) { [weak self] m, _ in
      guard let m else { return }
      Task { @MainActor in self?.update(m) }
    }
  }

  func recenter() { x = 0; z = 0; steps = 0; heading0 = rawHeading; heading = 0 }

  private func update(_ m: CMDeviceMotion) {
    // Which way the phone points along the floor. In a pocket the phone stands upright, so use the direction its back faces;
    // lying flatter, use its top edge. Reference frame: x = magnetic north, z = up, so y = west.
    let r = m.attitude.rotationMatrix
    let back = (n: -r.m31, w: -r.m32), top = (n: r.m21, w: r.m22)
    let v = (back.n * back.n + back.w * back.w) > 0.25 ? back : top
    rawHeading = atan2(-v.w, v.n) // clockwise from north
    if heading0 == nil { heading0 = rawHeading }
    heading = rawHeading - (heading0 ?? 0)

    // A step: the up-and-down push of walking, taken along gravity so the phone's orientation does not matter.
    let a = m.userAcceleration, g = m.gravity
    let vertical = -(a.x * g.x + a.y * g.y + a.z * g.z) // in g, positive = pushed upward
    bounce = bounce * 0.8 + vertical * 0.2
    let now = m.timestamp
    if armed, bounce > 0.11, now - lastStep > 0.33 {
      armed = false; lastStep = now; steps += 1
      x += sin(heading) * stepLength; z -= cos(heading) * stepLength
    } else if bounce < 0.02 { armed = true }
  }
}

/// How far the head is turned, from the glasses' motion sensor (Meta DAT Motion, a beta capability).
/// Ray-Ban Meta gives no compass, so this integrates the turn rate around the direction of gravity. It drifts slowly.
@MainActor
final class HeadTracker {
  private(set) var yaw = 0.0 // radians, clockwise, 0 = where the head faced at Recenter
  private(set) var samples = 0
  private var gravity = SIMD3<Float>(0, 0, 0)
  private var lastNs: Int64 = 0
  var flipped = false // if the cone turns the wrong way on screen

  func recenter() { yaw = 0 }

  func feed(_ s: MotionSample) {
    samples += 1
    if let a = s.accelerometer { gravity = gravity == .zero ? a.simd : gravity * 0.95 + a.simd * 0.05 } // at rest this points up
    defer { lastNs = s.timestampNs }
    guard let w = s.gyroscope, lastNs != 0, simd_length(gravity) > 1 else { return }
    let dt = Double(s.timestampNs - lastNs) / 1e9
    guard dt > 0, dt < 0.5 else { return }
    let up = simd_normalize(gravity)
    let turn = Double(simd_dot(w.simd, up)) // rad/s, counter-clockwise seen from above
    yaw += (flipped ? turn : -turn) * dt
  }
}

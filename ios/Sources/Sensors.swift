import Foundation
import CoreMotion
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
  private var bounce = 0.0, wasBelow = false, low = 0.0, high = 0.0, lastStep = 0.0
  private let pedometer = CMPedometer()
  private var counted = 0 // steps the system pedometer has reported since Recenter (arrives late, in batches)
  private var pedometerBase: Int?
  var stepLength = 0.7

  var available: Bool { motion.isDeviceMotionAvailable }

  func start() {
    guard motion.isDeviceMotionAvailable, !motion.isDeviceMotionActive else { return }
    motion.deviceMotionUpdateInterval = 1.0 / 50
    motion.startDeviceMotionUpdates(using: .xMagneticNorthZVertical, to: .main) { [weak self] m, _ in
      guard let m else { return }
      Task { @MainActor in self?.update(m) }
    }
    // Safety net: the system's own step counter. It is seconds late, so it never drives the position directly;
    // it only adds the steps the fast detector below missed.
    if CMPedometer.isStepCountingAvailable() {
      pedometer.startUpdates(from: Date()) { [weak self] data, _ in
        guard let n = data?.numberOfSteps.intValue else { return }
        Task { @MainActor in self?.catchUp(n) }
      }
    }
  }

  func recenter() { x = 0; z = 0; steps = 0; heading0 = rawHeading; heading = 0; pedometerBase = nil; counted = 0 }

  private func step() { steps += 1; x += sin(heading) * stepLength; z -= cos(heading) * stepLength }

  private func catchUp(_ total: Int) {
    if pedometerBase == nil { pedometerBase = total - steps } // line the two counters up at the first report
    counted = total - (pedometerBase ?? 0)
    var missing = counted - steps
    while missing > 0 { step(); missing -= 1 }
  }

  private func update(_ m: CMDeviceMotion) {
    // Which way the phone points along the floor. In a pocket the phone stands upright, so use the direction its back faces;
    // lying flatter, use its top edge. Reference frame: x = magnetic north, z = up, so y = west.
    let r = m.attitude.rotationMatrix
    let back = (n: -r.m31, w: -r.m32), top = (n: r.m21, w: r.m22)
    let v = (back.n * back.n + back.w * back.w) > 0.25 ? back : top
    rawHeading = atan2(-v.w, v.n) // clockwise from north
    if heading0 == nil { heading0 = rawHeading }
    heading = rawHeading - (heading0 ?? 0)

    // A step, the moment it happens: the body bounces once per step. Take the bounce along gravity (so the phone's
    // orientation does not matter), smooth it, and count one step each time it swings up through zero after a swing
    // of at least 0.07 g. This catches a soft walk with the phone in a pocket or in the hand.
    let a = m.userAcceleration, g = m.gravity
    let vertical = -(a.x * g.x + a.y * g.y + a.z * g.z) // in g, positive = pushed upward
    bounce = bounce * 0.75 + vertical * 0.25
    low = min(low, bounce); high = max(high, bounce)
    let now = m.timestamp
    if bounce < 0 { wasBelow = true }
    else if wasBelow {
      wasBelow = false
      let swing = high - low, gap = now - lastStep
      if swing > 0.07, gap > 0.28 { lastStep = now; step() }
      low = 0; high = 0
    }
  }
}

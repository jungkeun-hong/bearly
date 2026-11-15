import Foundation
import CoreBluetooth

/// A Vexo band over Bluetooth: its microphone (Opus packets) and its tap events.
/// Bytes follow the band's official JS kit (components/vexo in this repo, from the Vexo open kit):
///   codec.js                    frame layout, UUIDs, bandName(), command table
///   band.js                     connect() = GET_INFO, then TIME_SET on firmware 1.1; configure() = STREAM_START
///   transports/web-bluetooth.js one notification on TX = one frame; commands written to RX with response
/// Everything here runs on one serial queue; callbacks are called on that queue.
final class VexoBand: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  // codec.js
  static let serviceUUID = CBUUID(string: "254f0001-df82-4a9c-a2b5-563a0f6b2021")
  static let rxUUID = CBUUID(string: "254f0002-df82-4a9c-a2b5-563a0f6b2021") // we write commands here
  static let txUUID = CBUUID(string: "254f0003-df82-4a9c-a2b5-563a0f6b2021") // the band notifies here
  /// codec.js bandName(): "Vexo-HACK-" + the number with at least two digits.
  static func name(_ number: Int) -> String { "Vexo-HACK-" + (number < 10 ? "0\(number)" : "\(number)") }

  private enum Frame { static let command: UInt8 = 0x01, response: UInt8 = 0x02, notice: UInt8 = 0x03, event: UInt8 = 0x11, audio: UInt8 = 0x13 }
  private enum Op { static let getInfo: UInt8 = 0x01, timeSet: UInt8 = 0x07, streamStart: UInt8 = 0x10, streamStop: UInt8 = 0x11 }
  /// configure({ audio: true, events: true }): stream bits event = 1, audio = 3 (codec.js STREAM_TABLE).
  private static let mask: UInt16 = (1 << 1) | (1 << 3)

  /// A status line for people (goes to the Mac log).
  var onNote: ((String) -> Void)?
  /// "connected" | "disconnected" | "failed", with a note. Called only when the state changes.
  var onState: ((String, String) -> Void)?
  /// One audio frame: the band's seq and the raw Opus packet.
  var onAudio: ((UInt16, Data) -> Void)?
  /// "tap" or "double-tap".
  var onTap: ((String) -> Void)?

  private let queue = DispatchQueue(label: "vexo-band")
  private var central: CBCentralManager?
  private var peripheral: CBPeripheral?
  private var rx: CBCharacteristic?
  private var wanted = false
  private var number = 0
  private var state = ""
  private var attempt = 0 // bumps on every start/stop, so late timers of an old attempt do nothing
  private var seq: UInt8 = 0
  private var pending: (seq: UInt8, op: UInt8, done: (UInt8?, [UInt8]) -> Void)? // status nil = timeout

  // MARK: start / stop

  func start(number: Int) {
    queue.async { [self] in
      wanted = true; self.number = number; attempt += 1; state = ""
      if let central { centralManagerDidUpdateState(central) } // already powered on: scan now
      else { central = CBCentralManager(delegate: self, queue: queue) }
    }
  }

  /// Turns the band's streams off (configure off), then lets it go. Returns once it is gone (at most ~2.5 s).
  func stop() async {
    await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
      queue.async { [self] in
        wanted = false; attempt += 1
        central?.stopScan()
        let finish = { [self] in
          if let p = peripheral { central?.cancelPeripheralConnection(p) }
          peripheral = nil; rx = nil; pending = nil
          setState("disconnected", "stopped")
          cont.resume()
        }
        if rx != nil, peripheral?.state == .connected {
          command(Op.streamStop, le16(Self.mask)) { _, _ in finish() }
        } else { finish() }
      }
    }
  }

  // MARK: scan and connect

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    guard wanted else { return }
    switch central.state {
    case .poweredOn:
      guard peripheral == nil else { return }
      onNote?("Band: looking for \(Self.name(number))… (double-tap it to wake)")
      central.scanForPeripherals(withServices: [Self.serviceUUID], options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
      let mine = attempt
      queue.asyncAfter(deadline: .now() + 60) { [self] in
        guard attempt == mine, wanted, peripheral == nil else { return }
        central.stopScan()
        setState("failed", "\(Self.name(number)) not found in 60 s. Double-tap the band to wake it, then Stop and Start.")
      }
    case .unauthorized: setState("failed", "Bluetooth permission is off for this app")
    case .poweredOff: setState("failed", "Bluetooth is off")
    case .unsupported: setState("failed", "no Bluetooth LE on this phone")
    default: break
    }
  }

  func centralManager(_ central: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) {
    guard wanted, peripheral == nil else { return }
    let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? p.name
    guard name == Self.name(number) else { return }
    central.stopScan()
    peripheral = p; p.delegate = self
    onNote?("Band: found \(name ?? "?") (\(rssi) dBm), connecting…")
    central.connect(p)
    let mine = attempt
    queue.asyncAfter(deadline: .now() + 20) { [self] in // web-bluetooth.js connectSeconds = 20
      guard attempt == mine, wanted, peripheral === p, rx == nil else { return }
      central.cancelPeripheralConnection(p); peripheral = nil
      setState("failed", "\(Self.name(number)) did not answer within 20 s. Keep it close, then Stop and Start.")
    }
  }

  func centralManager(_ central: CBCentralManager, didConnect p: CBPeripheral) {
    p.discoverServices([Self.serviceUUID])
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
    guard wanted, p === peripheral else { return }
    peripheral = nil
    setState("failed", "could not connect: \(error?.localizedDescription ?? "unknown")")
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
    guard p === peripheral else { return }
    rx = nil
    if let pending { self.pending = nil; pending.done(nil, []) }
    guard wanted else { return }
    // Lost while wanted: iOS reconnects by itself as soon as the band is in reach again (connect() never times out).
    setState("disconnected", "link lost (\(error?.localizedDescription ?? "no reason")), will reconnect when in reach")
    attempt += 1
    central.connect(p)
  }

  func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
    guard let service = p.services?.first(where: { $0.uuid == Self.serviceUUID }) else {
      return fail(p, "band has no Vexo service (\(error?.localizedDescription ?? "-"))")
    }
    p.discoverCharacteristics([Self.rxUUID, Self.txUUID], for: service)
  }

  func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    let chars = service.characteristics ?? []
    guard let rx = chars.first(where: { $0.uuid == Self.rxUUID }), let tx = chars.first(where: { $0.uuid == Self.txUUID }) else {
      return fail(p, "band is missing RX/TX (\(error?.localizedDescription ?? "-"))")
    }
    self.rx = rx
    p.setNotifyValue(true, for: tx) // listen before the first command (web-bluetooth.js)
  }

  func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor c: CBCharacteristic, error: Error?) {
    guard c.uuid == Self.txUUID else { return }
    if let error { return fail(p, "could not subscribe: \(error.localizedDescription)") }
    handshake(p)
  }

  /// band.js connect(): GET_INFO (check the number), then TIME_SET on firmware 1.1+, then configure({ audio, events }).
  private func handshake(_ p: CBPeripheral) {
    command(Op.getInfo, []) { [self] status, d in
      guard status == 0, d.count == 16 else { return fail(p, status == nil ? "GET_INFO timed out" : "GET_INFO refused (status \(status!))") }
      let protoMajor = d[0], protoMinor = d[1], bandNo = Int(d[6]) | Int(d[7]) << 8, caps = Int(d[8]) | Int(d[9]) << 8
      guard bandNo == number else { return fail(p, "this is \(Self.name(bandNo)), not \(Self.name(number))") }
      if caps & (1 << 4) == 0 { onNote?("Band: this band reports no microphone") }
      let configure = { [self] in
        command(Op.streamStart, le16(Self.mask)) { [self] status, d in
          guard status == 0, d.count == 2 else { return fail(p, status == nil ? "STREAM_START timed out" : "STREAM_START refused (status \(status!))") }
          let active = UInt16(d[0]) | UInt16(d[1]) << 8
          setState("connected", "\(Self.name(number)) protocol \(protoMajor).\(protoMinor) · mic and taps on (active 0x\(String(active, radix: 16)))")
        }
      }
      guard protoMajor == 1, protoMinor >= 1 else { return configure() }
      // _syncClock(): a refusal is fine, the band keeps working.
      let ms = UInt64(Date().timeIntervalSince1970 * 1000)
      command(Op.timeSet, (0..<8).map { UInt8(truncatingIfNeeded: ms >> (8 * $0)) }) { [self] status, _ in
        if status == nil { return fail(p, "TIME_SET timed out") }
        configure()
      }
    }
  }

  private func fail(_ p: CBPeripheral, _ why: String) {
    setState("failed", why)
    central?.cancelPeripheralConnection(p)
    peripheral = nil; rx = nil; pending = nil
  }

  private func setState(_ new: String, _ why: String) {
    guard new != state else { return }
    state = new
    onState?(new, why)
  }

  // MARK: commands

  /// codec.js encodeCommand(): 01 seq opcode args (little-endian). One command in flight; 2 s to answer (band.js DEFAULT_TIMEOUT_MS).
  private func command(_ op: UInt8, _ args: [UInt8], done: @escaping (UInt8?, [UInt8]) -> Void) {
    guard let rx, let p = peripheral else { return done(nil, []) }
    let s = seq; seq &+= 1
    pending = (s, op, done)
    p.writeValue(Data([Frame.command, s, op] + args), for: rx, type: .withResponse)
    queue.asyncAfter(deadline: .now() + 2) { [self] in
      guard let pending, pending.seq == s, pending.op == op else { return }
      self.pending = nil
      pending.done(nil, [])
    }
  }

  private func le16(_ v: UInt16) -> [UInt8] { [UInt8(v & 0xff), UInt8(v >> 8)] }

  // MARK: incoming frames (one notification = one frame)

  func peripheral(_ p: CBPeripheral, didUpdateValueFor c: CBCharacteristic, error: Error?) {
    guard c.uuid == Self.txUUID, let value = c.value, !value.isEmpty else { return }
    let b = [UInt8](value)
    switch b[0] {
    case Frame.audio: // 13 seq:u16 len:u8 opus[len]
      guard b.count >= 4, 4 + Int(b[3]) <= b.count else { return }
      onAudio?(UInt16(b[1]) | UInt16(b[2]) << 8, Data(b[4..<(4 + Int(b[3]))]))
    case Frame.event: // 11 t_ms:u32 event:u8 arg:u8 ; 1 = tap, 2 = double-tap
      guard b.count >= 7 else { return }
      if b[5] == 1 { onTap?("tap") } else if b[5] == 2 { onTap?("double-tap") }
    case Frame.response: // 02 seq opcode status data
      guard b.count >= 4, let pending, pending.seq == b[1], pending.op == b[2] else { return }
      self.pending = nil
      pending.done(b[3], Array(b[4...]))
    case Frame.notice: // 03 code arg
      guard b.count >= 3 else { return }
      let kinds: [UInt8: String] = [1: "low battery", 2: "battery empty", 3: "a stream was dropped", 4: "on USB power"]
      onNote?("Band: \(kinds[b[1]] ?? "notice \(b[1])") (\(b[2]))")
    default: break
    }
  }
}

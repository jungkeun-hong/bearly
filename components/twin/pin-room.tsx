"use client"

// A small 3D view of where things were said, drawn as a dark space scene. Two layouts:
//  - "room": a schematic of the recorded walk (zones from world.ts, hand-built, not measured). A beam and a photo card
//    drop at the zone the wearer was standing in when they spoke. The zone comes from Jev looking at the frame.
//  - "path": no room model. Photo cards stand along a line in the order they were captured.
// Photos, boxes and values are real. Positions are zone-level in "room" and order-only in "path".
// When a card has a depth picture (an estimate from one photo, not a measurement) it is bent into a relief.

import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { Billboard, Html, Line, OrbitControls, Sparkles, Stars } from "@react-three/drei"
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing"
import { useEffect, useMemo, useRef, useState } from "react"
import * as THREE from "three"
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark"
import { ZONES } from "./world"

/** Live tracking from the phone in the pocket (steps and compass) and the glasses (head turn). Metres on the floor, radians. */
export type Track = { pos: [number, number]; heading: number; head: { yaw: number; pitch: number }; path: [number, number][]; steps: number }
export type Pin = { id: number; n: number; t: number; box: number[] | null; where?: [number, number] | null; zone: string | null; shot: string | null; depth?: string | null; tag: string; bought: boolean }

/** A real reconstruction of the walk made from the glasses video (points + where the camera was in each frame). Scale is arbitrary. */
export type Recon = {
  count: number; points: Float32Array; colors: Float32Array
  frames: { t: number; pos: [number, number, number]; fwd: [number, number, number]; up: [number, number, number] }[]
  grid: { w: number; h: number; data: Float32Array }
}
const unb64 = (s: string) => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }
export async function loadRecon(url: string): Promise<Recon | null> {
  try {
    const r = await fetch(url)
    if (!r.ok) return null
    const d = await r.json()
    const rgb = unb64(d.colors), colors = new Float32Array(rgb.length)
    for (let i = 0; i < rgb.length; i++) colors[i] = (rgb[i] / 255) ** 2.2 // sRGB to linear for vertex colours
    return { count: d.count, points: new Float32Array(unb64(d.points).buffer), colors, frames: d.frames, grid: { w: d.grid.w, h: d.grid.h, data: new Float32Array(unb64(d.grid.data).buffer) } }
  } catch { return null }
}
/** Index of the reconstructed frame closest in time, and how far along to the next one. */
function frameAt(recon: Recon, t: number): [number, number] {
  const f = recon.frames
  let i = 0
  while (i < f.length - 2 && f[i + 1].t <= t) i++
  return [i, Math.min(1, Math.max(0, (t - f[i].t) / Math.max(0.001, f[i + 1].t - f[i].t)))]
}
/** The 3D point the wearer was looking at: the reconstructed surface under the middle of the box, in the frame nearest that moment. */
function pointFor(recon: Recon, t: number, box: number[] | null): [number, number, number] {
  const [i, k] = frameAt(recon, t)
  const fi = k > 0.5 ? i + 1 : i, g = recon.grid
  const u = box ? (box[1] + box[3]) / 2000 : 0.5, v = box ? (box[0] + box[2]) / 2000 : 0.5
  const o = ((fi * g.h + Math.round(v * (g.h - 1))) * g.w + Math.round(u * (g.w - 1))) * 3
  return [g.data[o], g.data[o + 1], g.data[o + 2]]
}

const ZONE = Object.fromEntries(ZONES.map((z) => [z.id, z]))
const INK = "#F4F4F2", GLOW = "#9FB4FF", DIM = "#5C6480", GOLD = "#FFD100"

function place(pins: Pin[], room: boolean): Record<number, [number, number]> {
  const out: Record<number, [number, number]> = {}
  const perZone: Record<string, number> = {}
  let last: [number, number] = [0, 0]
  pins.forEach((p, i) => {
    const z = room && p.zone ? ZONE[p.zone] : null
    if (z) {
      const k = (perZone[z.id] = (perZone[z.id] ?? 0) + 1) - 1 // several pins in one zone fan out around it
      out[p.id] = [z.stand[0] + Math.cos(k * 2.1) * 1.1 * Math.min(1, k), z.stand[1] + Math.sin(k * 2.1) * 1.1 * Math.min(1, k)]
    } else if (room) out[p.id] = [last[0] + 1.3, last[1] + 0.4] // zone unknown for that frame: next to the previous pin
    else out[p.id] = [i * 2.6 - 1, Math.sin(i * 0.9) * 0.8]
    last = out[p.id]
  })
  return out
}

function useTex(url: string | null | undefined, srgb: boolean) {
  const tex = useMemo(() => {
    if (!url) return null
    const t = new THREE.TextureLoader().load(url)
    if (srgb) t.colorSpace = THREE.SRGBColorSpace
    return t
  }, [url, srgb])
  useEffect(() => () => tex?.dispose(), [tex])
  return tex
}

function PinCard({ pin, at }: { pin: Pin; at: [number, number] }) {
  const group = useRef<THREE.Group>(null)
  const beam = useRef<THREE.Mesh>(null)
  const photo = useTex(pin.shot, true), depth = useTex(pin.depth, false)
  const born = useRef(0)
  useFrame((state, dt) => {
    const g = group.current
    if (!g) return
    if (!born.current) born.current = state.clock.elapsedTime
    g.position.y += (0 - g.position.y) * Math.min(1, dt * 6) // drops in from above and settles
    const age = state.clock.elapsedTime - born.current
    if (beam.current) (beam.current.material as THREE.MeshBasicMaterial).opacity = 0.16 + Math.max(0, 0.7 - age * 0.5) // landing flash fades to a soft beam
  })
  const color = pin.bought ? GOLD : INK
  return (
    <group ref={group} position={[at[0], 7, at[1]]}>
      <mesh ref={beam} position={[0, 3, 0]}><cylinderGeometry args={[0.035, 0.035, 6, 8]} /><meshBasicMaterial color={pin.bought ? GOLD : GLOW} transparent opacity={0.8} /></mesh>
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.22, 0.3, 48]} /><meshBasicMaterial color={color} /></mesh>
      <mesh position={[0, 0.015, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.45, 0.47, 48]} /><meshBasicMaterial color={color} transparent opacity={0.35} /></mesh>
      {/* The card faces the default view; orbiting shows the relief from the side. */}
      <group position={[0, 2.7, 0]} rotation={[0, 0.22, 0]}>
        <mesh position={[0, 0, -0.03]}><planeGeometry args={[1.62, 2.12]} /><meshBasicMaterial color={color} side={THREE.DoubleSide} /></mesh>
        {photo && (depth
          ? <mesh><planeGeometry args={[1.5, 2, 96, 128]} /><meshStandardMaterial color="#000" emissive="#fff" emissiveMap={photo} emissiveIntensity={0.92} displacementMap={depth} displacementScale={0.75} toneMapped={false} /></mesh>
          : <mesh><planeGeometry args={[1.5, 2]} /><meshBasicMaterial map={photo} toneMapped={false} /></mesh>)}
        <Html center position={[0, 1.34, 0.4]} distanceFactor={11} style={{ pointerEvents: "none" }}>
          <div style={{ whiteSpace: "nowrap", background: color, color: "#0B0B0C", font: "700 13px Inter, sans-serif", padding: "3px 8px", borderRadius: 6 }}>{pin.n} · {pin.tag}</div>
        </Html>
      </group>
    </group>
  )
}

function Me({ at }: { at: [number, number] }) {
  const g = useRef<THREE.Group>(null), ring = useRef<THREE.Mesh>(null)
  useFrame((state, dt) => {
    if (g.current) { g.current.position.x += (at[0] - g.current.position.x) * Math.min(1, dt * 4); g.current.position.z += (at[1] - g.current.position.z) * Math.min(1, dt * 4) }
    if (ring.current) { const k = (state.clock.elapsedTime % 1.6) / 1.6; ring.current.scale.setScalar(1 + k * 3); (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - k) }
  })
  return (
    <group ref={g} position={[at[0], 0, at[1]]}>
      <mesh position={[0, 0.55, 0]}><capsuleGeometry args={[0.16, 0.55, 4, 12]} /><meshBasicMaterial color={INK} /></mesh>
      <mesh ref={ring} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.28, 0.32, 48]} /><meshBasicMaterial color={GLOW} transparent /></mesh>
      <pointLight position={[0, 1.2, 0]} color={GLOW} intensity={6} distance={5} />
    </group>
  )
}

function Rig({ target }: { target: [number, number] }) {
  const controls = useRef<React.ComponentRef<typeof OrbitControls>>(null)
  const goal = useMemo(() => new THREE.Vector3(), [])
  useFrame((_, dt) => {
    const c = controls.current
    if (!c) return
    goal.set(target[0], 1.4, target[1])
    c.target.lerp(goal, Math.min(1, dt * 2)) // the view drifts to the newest pin
    c.update()
  })
  return <OrbitControls ref={controls} enablePan={false} minDistance={6} maxDistance={26} maxPolarAngle={Math.PI / 2.15} autoRotate autoRotateSpeed={0.7} />
}

/** A World Labs Marble world of the room (Gaussian splat, .spz), drawn with Spark. It looks like the room, but Marble
 *  fills in what the video did not show, and its size is arbitrary until it is scaled by hand. */
const WORLD = "/twin-local/world.spz"
/** Height of the floor in a splat world: the biggest flat layer in the lower half of it. Returned for both ways up. */
function findFloors(world: SplatMesh): [number, number] {
  const ys: number[] = []
  let i = 0
  world.forEachSplat((_index, center, _scales, _quaternion, opacity) => { if (i++ % 7 === 0 && opacity > 0.4) ys.push(center.y) })
  const floorOf = (v: number[]) => {
    if (v.length < 200) return 0
    const sorted = [...v].sort((a, b) => a - b)
    const lo = sorted[Math.floor(sorted.length * 0.01)], mid = sorted[Math.floor(sorted.length * 0.5)]
    const bins = new Array(Math.max(1, Math.ceil((mid - lo) / 0.05))).fill(0)
    for (const y of sorted) { if (y > mid) break; if (y >= lo) bins[Math.min(bins.length - 1, Math.floor((y - lo) / 0.05))]++ }
    return lo + (bins.indexOf(Math.max(...bins)) + 0.5) * 0.05
  }
  return [floorOf(ys), floorOf(ys.map((y) => -y))]
}

function Splat({ onFail, onReady, flip }: { onFail: () => void; onReady: (floors: [number, number]) => void; flip: boolean }) {
  const { gl, scene } = useThree()
  const group = useRef<THREE.Group>(null)
  const mesh = useRef<SplatMesh | null>(null)
  // Exports differ on which way is up, so this can be turned over from the panel.
  useEffect(() => { mesh.current?.quaternion.set(flip ? 1 : 0, 0, 0, flip ? 0 : 1) }, [flip])
  useEffect(() => {
    const spark = new SparkRenderer({ renderer: gl })
    scene.add(spark)
    const world = new SplatMesh({ url: WORLD })
    world.quaternion.set(flip ? 1 : 0, 0, 0, flip ? 0 : 1)
    mesh.current = world
    group.current?.add(world)
    world.initialized.then(() => { let floors: [number, number] = [0, 0]; try { floors = findFloors(world) } catch { /* keep 0 */ } onReady(floors) }).catch(onFail)
    return () => { mesh.current = null; world.removeFromParent(); scene.remove(spark); world.dispose() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, onFail])
  return <group ref={group} />
}

function Cloud({ recon }: { recon: Recon }) {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.BufferAttribute(recon.points, 3))
    g.setAttribute("color", new THREE.BufferAttribute(recon.colors, 3))
    return g
  }, [recon])
  useEffect(() => () => geo.dispose(), [geo])
  return <points geometry={geo}><pointsMaterial size={0.035} vertexColors sizeAttenuation toneMapped={false} /></points>
}

/** The glasses, as a view cone that moves along the reconstructed camera path in step with the video. */
function Glasses({ recon, time, onMove }: { recon: Recon; time: number; onMove: (p: THREE.Vector3) => void }) {
  const g = useRef<THREE.Group>(null)
  const pos = useMemo(() => new THREE.Vector3(), []), fwd = useMemo(() => new THREE.Vector3(), []), up = useMemo(() => new THREE.Vector3(), [])
  const m = useMemo(() => new THREE.Matrix4(), []), q = useMemo(() => new THREE.Quaternion(), []), a = useMemo(() => new THREE.Vector3(), [])
  useFrame((_, dt) => {
    const [i, k] = frameAt(recon, time), f0 = recon.frames[i], f1 = recon.frames[i + 1] ?? f0
    pos.fromArray(f0.pos).lerp(a.fromArray(f1.pos), k)
    fwd.fromArray(f0.fwd).lerp(a.fromArray(f1.fwd), k).normalize()
    up.fromArray(f0.up).lerp(a.fromArray(f1.up), k).normalize()
    m.lookAt(pos, a.copy(pos).add(fwd), up); q.setFromRotationMatrix(m)
    if (g.current) { g.current.position.lerp(pos, Math.min(1, dt * 8)); g.current.quaternion.slerp(q, Math.min(1, dt * 8)); onMove(g.current.position) }
  })
  const cone: [number, number, number][] = [[0, 0, 0], [-0.3, 0.4, -0.8], [0.3, 0.4, -0.8], [0, 0, 0], [0.3, -0.4, -0.8], [-0.3, -0.4, -0.8], [0, 0, 0], [-0.3, 0.4, -0.8], [-0.3, -0.4, -0.8], [0.3, -0.4, -0.8], [0.3, 0.4, -0.8]]
  return (
    <group ref={g}>
      <Line points={cone} color={INK} lineWidth={2} />
      <mesh><sphereGeometry args={[0.09, 16, 16]} /><meshBasicMaterial color={INK} /></mesh>
      <pointLight color={GLOW} intensity={4} distance={4} />
    </group>
  )
}

function ReconPin({ pin, at }: { pin: Pin; at: [number, number, number] }) {
  const photo = useTex(pin.shot, true)
  const g = useRef<THREE.Group>(null)
  useFrame((_, dt) => { if (g.current) g.current.scale.lerp(new THREE.Vector3(1, 1, 1), Math.min(1, dt * 6)) })
  const color = pin.bought ? GOLD : INK
  return (
    <group ref={g} position={at} scale={0.01}>
      <mesh><sphereGeometry args={[0.1, 20, 20]} /><meshBasicMaterial color={color} /></mesh>
      <mesh><sphereGeometry args={[0.2, 20, 20]} /><meshBasicMaterial color={color} transparent opacity={0.25} /></mesh>
      <Line points={[[0, 0, 0], [0, 1.1, 0]]} color={color} lineWidth={1.5} />
      <Billboard position={[0, 1.75, 0]}>
        <mesh position={[0, 0, -0.01]}><planeGeometry args={[0.98, 1.3]} /><meshBasicMaterial color={color} /></mesh>
        {photo && <mesh><planeGeometry args={[0.9, 1.2]} /><meshBasicMaterial map={photo} toneMapped={false} /></mesh>}
        <Html center position={[0, 0.85, 0]} distanceFactor={9} style={{ pointerEvents: "none" }}>
          <div style={{ whiteSpace: "nowrap", background: color, color: "#0B0B0C", font: "700 13px Inter, sans-serif", padding: "3px 8px", borderRadius: 6 }}>{pin.n} · {pin.tag}</div>
        </Html>
      </Billboard>
    </group>
  )
}

function ReconScene({ recon, pins, time }: { recon: Recon; pins: Pin[]; time: number }) {
  const controls = useRef<React.ComponentRef<typeof OrbitControls>>(null)
  const walked = useMemo(() => recon.frames.filter((f) => f.t <= time + 0.01).map((f) => f.pos), [recon, Math.floor(time)]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Cloud recon={recon} />
      {walked.length > 1 && <Line points={walked} color={INK} lineWidth={2} transparent opacity={0.8} />}
      <Glasses recon={recon} time={time} onMove={(p) => { const c = controls.current; if (c) { c.target.lerp(p, 0.05); c.update() } }} />
      {pins.map((p) => <ReconPin key={p.id} pin={p} at={pointFor(recon, p.t, p.box)} />)}
      <OrbitControls ref={controls} enablePan={false} minDistance={2} maxDistance={30} autoRotate autoRotateSpeed={0.5} />
    </>
  )
}

/** "VEXO" in white on black, drawn once, for the front of the bear's cap. */
function capLabel(): THREE.CanvasTexture {
  const c = document.createElement("canvas")
  c.width = 256; c.height = 96
  const g = c.getContext("2d")!
  g.fillStyle = "#101012"; g.fillRect(0, 0, 256, 96)
  g.fillStyle = "#FFFFFF"; g.font = "900 64px Arial, Helvetica, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"
  g.fillText("VEXO", 128, 52)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/**
 * The wearer as a real 3D bear: black VEXO cap, black wristband on the left wrist. About 1.4 m tall, faces -z.
 * It turns smoothly to the way the body is heading, swings arms and legs in step with how fast it is moving,
 * and turns its head with the glasses. All plain shapes with soft lighting, so it needs no model file.
 */
function Bear3D({ track, body }: { track: Track; body: React.RefObject<THREE.Group | null> }) {
  const root = useRef<THREE.Group>(null), head = useRef<THREE.Group>(null), torso = useRef<THREE.Group>(null)
  const armL = useRef<THREE.Group>(null), armR = useRef<THREE.Group>(null), legL = useRef<THREE.Group>(null), legR = useRef<THREE.Group>(null)
  const last = useMemo(() => new THREE.Vector3(), [])
  const walk = useRef({ phase: 0, amount: 0, yaw: 0, started: false })
  const label = useMemo(() => capLabel(), [])
  const FUR = "#B8743A", DARK = "#8A5226", CREAM = "#F0DCB8", INKY = "#141416"
  useFrame((state, dt) => {
    const w = walk.current, at = body.current?.position
    if (!at || !root.current) return
    if (!w.started) { last.copy(at); w.yaw = -track.heading; w.started = true }
    const speed = at.distanceTo(last) / Math.max(dt, 0.001) // metres a second, after the smoothing the body already has
    last.copy(at)
    const target = Math.min(1, speed / 0.5)
    w.amount += (target - w.amount) * Math.min(1, dt * 6) // ease in and out of the walk, so it never snaps
    w.phase += dt * (5 + 5 * w.amount) * (w.amount > 0.02 ? 1 : 0)
    // turn the short way round toward the heading
    let d = -track.heading - w.yaw
    d = Math.atan2(Math.sin(d), Math.cos(d))
    w.yaw += d * Math.min(1, dt * 5)
    root.current.rotation.y = w.yaw
    const swing = Math.sin(w.phase) * 0.75 * w.amount, t = state.clock.elapsedTime
    if (legL.current) legL.current.rotation.x = swing
    if (legR.current) legR.current.rotation.x = -swing
    if (armL.current) armL.current.rotation.x = -swing * 0.8
    if (armR.current) armR.current.rotation.x = swing * 0.8
    root.current.position.y = Math.abs(Math.sin(w.phase)) * 0.05 * w.amount
    if (torso.current) { torso.current.rotation.z = Math.sin(w.phase) * 0.06 * w.amount; torso.current.scale.y = 1 + Math.sin(t * 2) * 0.012 * (1 - w.amount) } // sway while walking, breathe while standing
    if (head.current) {
      const turn = THREE.MathUtils.clamp(-track.head.yaw, -1.1, 1.1) // the glasses turn the head, not the body
      head.current.rotation.y += (turn - head.current.rotation.y) * Math.min(1, dt * 8)
      head.current.rotation.x = THREE.MathUtils.clamp(-track.head.pitch, -0.5, 0.5) + Math.sin(t * 1.3) * 0.02
    }
  })
  const fur = <meshStandardMaterial color={FUR} roughness={0.95} />
  const ball = (key: string, at: [number, number, number], r: number, color: string, scale: [number, number, number] = [1, 1, 1]) => (
    <mesh key={key} position={at} scale={scale}><sphereGeometry args={[r, 24, 18]} /><meshStandardMaterial color={color} roughness={0.95} /></mesh>
  )
  return (
    <group ref={root}>
      <hemisphereLight args={["#ffffff", "#5a4a3a", 2.2]} />
      <directionalLight position={[1.5, 3, -2]} intensity={1.6} />
      <group ref={torso}>
        {ball("body", [0, 0.56, 0], 0.36, FUR, [1, 1.1, 0.92])}
        {ball("belly", [0, 0.54, -0.17], 0.27, CREAM, [0.95, 1.05, 0.6])}
        {ball("tail", [0, 0.36, 0.33], 0.08, FUR)}
        <group ref={armL} position={[-0.36, 0.78, 0]}>
          <mesh position={[-0.03, -0.2, 0]} scale={[0.8, 1.7, 0.8]}><sphereGeometry args={[0.12, 20, 14]} />{fur}</mesh>
          {/* the wristband */}
          <mesh position={[-0.04, -0.33, 0]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[0.105, 0.105, 0.09, 20]} /><meshStandardMaterial color={INKY} roughness={0.7} /></mesh>
          <mesh position={[-0.04, -0.33, -0.1]}><boxGeometry args={[0.07, 0.05, 0.02]} /><meshStandardMaterial color="#B9B9B5" metalness={0.8} roughness={0.3} /></mesh>
        </group>
        <group ref={armR} position={[0.36, 0.78, 0]}>
          <mesh position={[0.03, -0.2, 0]} scale={[0.8, 1.7, 0.8]}><sphereGeometry args={[0.12, 20, 14]} />{fur}</mesh>
        </group>
        <group ref={head} position={[0, 1.02, 0]}>
          {ball("head", [0, 0.1, 0], 0.31, FUR)}
          {ball("earL", [-0.24, 0.34, 0.02], 0.1, FUR)}{ball("earR", [0.24, 0.34, 0.02], 0.1, FUR)}
          {ball("earLi", [-0.24, 0.34, -0.03], 0.055, DARK)}{ball("earRi", [0.24, 0.34, -0.03], 0.055, DARK)}
          {ball("muzzle", [0, 0.03, -0.26], 0.13, CREAM, [1.1, 0.85, 0.8])}
          {ball("nose", [0, 0.07, -0.37], 0.045, INKY)}
          {ball("eyeL", [-0.115, 0.16, -0.275], 0.035, INKY)}{ball("eyeR", [0.115, 0.16, -0.275], 0.035, INKY)}
          {ball("glintL", [-0.105, 0.172, -0.305], 0.011, "#FFFFFF")}{ball("glintR", [0.125, 0.172, -0.305], 0.011, "#FFFFFF")}
          {/* cap: a dome, a brim pointing forward, and the VEXO label on the front */}
          <mesh position={[0, 0.2, 0]}><sphereGeometry args={[0.325, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2]} /><meshStandardMaterial color={INKY} roughness={0.8} /></mesh>
          <mesh position={[0, 0.21, -0.36]} rotation={[-0.12, 0, 0]} scale={[1, 1, 0.75]}><cylinderGeometry args={[0.26, 0.26, 0.025, 24, 1, false, Math.PI / 2, Math.PI]} /><meshStandardMaterial color={INKY} roughness={0.8} /></mesh>
          <mesh position={[0, 0.33, -0.285]} rotation={[-0.62, 0, 0]}><planeGeometry args={[0.3, 0.11]} /><meshBasicMaterial map={label} toneMapped={false} /></mesh>
        </group>
      </group>
      <group ref={legL} position={[-0.17, 0.3, 0]}><mesh position={[0, -0.16, -0.02]} scale={[1, 1.25, 1.15]}><sphereGeometry args={[0.14, 20, 14]} /><meshStandardMaterial color={DARK} roughness={0.95} /></mesh></group>
      <group ref={legR} position={[0.17, 0.3, 0]}><mesh position={[0, -0.16, -0.02]} scale={[1, 1.25, 1.15]}><sphereGeometry args={[0.14, 20, 14]} /><meshStandardMaterial color={DARK} roughness={0.95} /></mesh></group>
    </group>
  )
}

/** The wearer, live: a body where the phone says they are, and a view cone turned by the phone's compass plus the glasses' head turn. */
function Wearer({ track, onMove }: { track: Track; onMove: (p: THREE.Vector3) => void }) {
  const body = useRef<THREE.Group>(null), cone = useRef<THREE.Group>(null), ring = useRef<THREE.Mesh>(null)
  const goal = useMemo(() => new THREE.Vector3(), [])
  useFrame((state, dt) => {
    goal.set(track.pos[0], 0, track.pos[1])
    // Glide to where the phone says we are. Slower than before, so counted steps turn into a walk and not a jump.
    if (body.current) { body.current.position.lerp(goal, Math.min(1, dt * 5)); onMove(body.current.position) }
    if (cone.current) {
      const yaw = -(track.heading + track.head.yaw) // heading is clockwise from "up the screen"; three.js turns the other way
      cone.current.rotation.set(0, 0, 0); cone.current.rotateY(yaw); cone.current.rotateX(-track.head.pitch)
    }
    if (ring.current) { const k = (state.clock.elapsedTime % 1.6) / 1.6; ring.current.scale.setScalar(1 + k * 3); (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - k) }
  })
  const lines: [number, number, number][] = [[0, 0, 0], [-0.55, 0.4, -1.5], [0.55, 0.4, -1.5], [0, 0, 0], [0.55, -0.4, -1.5], [-0.55, -0.4, -1.5], [0, 0, 0], [-0.55, 0.4, -1.5], [-0.55, -0.4, -1.5], [0.55, -0.4, -1.5], [0.55, 0.4, -1.5]]
  return (
    <group ref={body}>
      <Bear3D track={track} body={body} />
      <mesh ref={ring} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.28, 0.32, 48]} /><meshBasicMaterial color={GLOW} transparent /></mesh>
      <group ref={cone} position={[0, 1.2, 0]}><Line points={lines} color={GLOW} lineWidth={1.2} transparent opacity={0.55} /></group>
      <pointLight position={[0, 1.4, 0]} color={GLOW} intensity={6} distance={5} />
    </group>
  )
}

/** How the rebuilt space is laid over the live tracking: turned, scaled and shifted by hand until the two agree. */
export type Cal = { yaw: number; scale: number; x: number; z: number }

/** Placing yourself in the rebuilt room by hand: two clicks on its floor, where you stand and what you face. */
type Align = { yaw: number; x: number; z: number }
type Placing = null | { step: 1 } | { step: 2; a: [number, number] }
const turn = (x: number, z: number, yaw: number): [number, number] => [x * Math.cos(yaw) + z * Math.sin(yaw), -x * Math.sin(yaw) + z * Math.cos(yaw)] // same turn three.js makes for rotation.y
const bearing = (x: number, z: number) => Math.atan2(x, -z) // clockwise from "up the screen", like the phone's heading

function TrackScene({ track, pins, space, splat, flip, drop, onSplatFail, onSplatReady, cal, align, placing, onPlace }: { track: Track | null; pins: Pin[]; space: Recon | null; splat: boolean; flip: boolean; drop: number; onSplatFail: () => void; onSplatReady: (floors: [number, number]) => void; cal: Cal; align: Align; placing: Placing; onPlace: (x: number, z: number) => void }) {
  const controls = useRef<React.ComponentRef<typeof OrbitControls>>(null)
  const path = useMemo(() => (track?.path ?? []).map(([x, z]) => [x, 0.04, z] as [number, number, number]), [track?.path])
  let last: [number, number] = track?.pos ?? [0, 0]
  return (
    <>
      <gridHelper args={[60, 60, "#1B2140", "#10142A"]} position={[0, -0.02, 0]} />
      {(space || splat) && <group position={[cal.x + align.x, splat ? -drop * cal.scale : 0, cal.z + align.z]} rotation={[0, cal.yaw + align.yaw, 0]} scale={cal.scale}>{splat ? <Splat onFail={onSplatFail} onReady={onSplatReady} flip={flip} /> : space && <Cloud recon={space} />}</group>}
      {/* While placing, the floor takes clicks and the view stops turning. */}
      {placing && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} onPointerDown={(e) => { e.stopPropagation(); onPlace(e.point.x, e.point.z) }}><planeGeometry args={[200, 200]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} /></mesh>}
      {placing?.step === 2 && <mesh position={[placing.a[0], 0.03, placing.a[1]]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.25, 0.34, 40]} /><meshBasicMaterial color={GOLD} /></mesh>}
      {path.length > 1 && <Line points={path} color={INK} lineWidth={2.5} transparent opacity={0.85} />}
      {track ? <Wearer track={track} onMove={(p) => {
        // Close view that travels with the wearer: the look-at point eases to them and the camera moves by the same amount,
        // so the framing you set by dragging or zooming is kept while they walk.
        const c = controls.current
        if (!c || placing) return
        const dx = (p.x - c.target.x) * 0.08, dy = (0.9 - c.target.y) * 0.08, dz = (p.z - c.target.z) * 0.08
        c.target.x += dx; c.target.y += dy; c.target.z += dz
        const cam = c.object.position
        cam.x += dx; cam.z += dz
        // Never inside the wearer: at least 2.5 m away along the floor-plus-height line, and at least 1.2 m above the look-at point.
        const ox = cam.x - c.target.x, oy = cam.y - c.target.y, oz = cam.z - c.target.z
        const dist = Math.hypot(ox, oy, oz)
        if (dist < 2.5) { const k = 2.5 / Math.max(dist, 0.01); cam.x = c.target.x + ox * k; cam.y = c.target.y + oy * k; cam.z = c.target.z + oz * k }
        if (cam.y < c.target.y + 1.2) cam.y = c.target.y + 1.2
        c.update()
      }} />
        : space && <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.2, 0.27, 40]} /><meshBasicMaterial color={INK} /></mesh>}
      {pins.map((p, i) => { const at = p.where ?? [last[0] + (i ? 0.9 : 0), last[1]]; last = at; return <PinCard key={p.id} pin={p} at={at} /> })}
      <OrbitControls ref={controls} enabled={!placing} enablePan={false} target={[0, 0.9, 0]} minDistance={2.5} maxDistance={40} maxPolarAngle={Math.PI / 2.6} autoRotate={!placing} autoRotateSpeed={0.35} />
    </>
  )
}

/** The live view with the rebuilt room behind it, plus the "Place me" control that lines the two up. */
function LiveRoom({ track, pins, space, cal }: { track: Track | null; pins: Pin[]; space: Recon | null; cal: Cal }) {
  const [align, setAlign] = useState<Align>({ yaw: 0, x: 0, z: 0 })
  const [placing, setPlacing] = useState<Placing>(null)
  // Use the Marble world when its file is there; otherwise the point cloud rebuilt from the video.
  const [splat, setSplat] = useState(false)
  useEffect(() => { fetch(WORLD, { method: "HEAD" }).then((r) => setSplat(r.ok && Number(r.headers.get("content-length") ?? 1) > 1000)).catch(() => setSplat(false)) }, [])
  const dropSplat = useMemo(() => () => setSplat(false), [])
  const [ready, setReady] = useState(false)
  const [floors, setFloors] = useState<[number, number]>([0, 0]) // floor height found in the world, as saved and flipped
  const [lift, setLift] = useState(0) // hand correction on top of that, in metres of world height
  useEffect(() => { try { setLift(Number(localStorage.getItem("vb-lift")) || 0) } catch { /* nothing saved */ } }, [])
  const nudgeLift = (d: number) => setLift((v) => { const n = Math.round((v + d) * 100) / 100; try { localStorage.setItem("vb-lift", String(n)) } catch { /* private window */ } return n })
  const splatReady = useMemo(() => (f: [number, number]) => { setFloors(f); setReady(true) }, [])
  const [flip, setFlip] = useState(false) // the Marble export was saved as OpenGL, ground level, so it should already be upright
  useEffect(() => { try { setFlip(localStorage.getItem("vb-flip") === "1") } catch { /* nothing saved */ } }, [])
  useEffect(() => { try { const saved = localStorage.getItem("vb-align-2"); if (saved) setAlign(JSON.parse(saved)) } catch { /* nothing saved */ } }, [])
  const save = (a: Align) => { setAlign(a); try { localStorage.setItem("vb-align-2", JSON.stringify(a)) } catch { /* private window */ } }
  const trackRef = useRef(track)
  trackRef.current = track

  const onPlace = (x: number, z: number) => {
    if (!placing) return
    if (placing.step === 1) { setPlacing({ step: 2, a: [x, z] }); return }
    // Where the two clicks are in the room's own coordinates, before any move.
    const yaw0 = cal.yaw + align.yaw, off0: [number, number] = [cal.x + align.x, cal.z + align.z]
    const local = (p: [number, number]) => turn(p[0] - off0[0], p[1] - off0[1], -yaw0)
    const a = local(placing.a), b = local([x, z])
    // Where the wearer is and faces right now, in the live tracking's coordinates.
    const k = trackRef.current
    const me: [number, number] = k ? k.pos : [0, 0], facing = k ? k.heading + k.head.yaw : 0
    // Turn the room so "from where I stand to what I face" points the way I am facing, then slide it so that spot is under me.
    const yaw = bearing(b[0] - a[0], b[1] - a[1]) - facing
    const at = turn(a[0], a[1], yaw)
    save({ yaw: yaw - cal.yaw, x: me[0] - at[0] - cal.x, z: me[1] - at[1] - cal.z })
    setPlacing(null)
  }

  return (
    <div className="relative h-full w-full">
      {/* Starts close, just behind and above the wearer, inside the room rather than looking down on it from far away. */}
      <Canvas dpr={[1, 1.75]} camera={{ position: [2.2, 3.2, 4.4], fov: 50, near: 0.05 }} gl={{ antialias: true }}>
        <color attach="background" args={["#05060A"]} />
        <Stars radius={60} depth={30} count={2200} factor={3} saturation={0} fade speed={0.6} />
        <TrackScene track={track} pins={pins} space={space} splat={splat} flip={flip} drop={(flip ? floors[1] : floors[0]) + lift} onSplatFail={dropSplat} onSplatReady={splatReady} cal={cal} align={align} placing={placing} onPlace={onPlace} />
        <EffectComposer>
          <Bloom intensity={space ? 0.25 : 0.9} luminanceThreshold={space ? 0.9 : 0.55} luminanceSmoothing={0.3} mipmapBlur />
          <Vignette eskil={false} offset={0.2} darkness={0.75} />
        </EffectComposer>
      </Canvas>
      {splat && !ready && <p data-loading className="pointer-events-none absolute inset-x-0 bottom-10 text-center text-xs text-[#B9B9B5]">Loading the room…</p>}
      {(space || splat) && (
        <div className="absolute left-3 top-9 flex items-center gap-2 text-xs">
          <button data-place onClick={() => setPlacing(placing ? null : { step: 1 })} className={`rounded-full px-3 py-1 font-semibold ${placing ? "bg-[#FFD100] text-[#0B0B0C]" : "border border-[#3A3A3F] bg-black/50 text-[#D3D3D1]"}`}>{placing ? "Cancel" : "Place me"}</button>
          {splat && !placing && <button onClick={() => { const n = !flip; setFlip(n); try { localStorage.setItem("vb-flip", n ? "1" : "0") } catch { /* private window */ } }} className="rounded-full border border-[#3A3A3F] bg-black/50 px-3 py-1 text-[#D3D3D1]">Flip</button>}
          {splat && !placing && <button onClick={() => nudgeLift(0.1)} title="Lower the room: use it when the bear stands sunk into the floor" className="rounded-full border border-[#3A3A3F] bg-black/50 px-2.5 py-1 text-[#D3D3D1]">Floor ↓</button>}
          {splat && !placing && <button onClick={() => nudgeLift(-0.1)} title="Raise the room: use it when the bear floats above the floor" className="rounded-full border border-[#3A3A3F] bg-black/50 px-2.5 py-1 text-[#D3D3D1]">Floor ↑</button>}
          {splat && !placing && <button onClick={() => setSplat(false)} title="Show the point cloud rebuilt from the video instead" className="rounded-full border border-[#3A3A3F] bg-black/50 px-3 py-1 text-[#D3D3D1]">Points</button>}
          {placing && <span className="rounded-full bg-black/70 px-3 py-1 text-[#F4F4F2]">{placing.step === 1 ? "1 of 2 · click the floor where you are standing" : "2 of 2 · click the thing you are facing"}</span>}
        </div>
      )}
    </div>
  )
}

export default function PinRoom({ pins, here, trail, recon = null, time = 0, track = null, space = null, cal = { yaw: 0, scale: 1, x: 0, z: 0 } }: { pins: Pin[]; here: string | null; trail: string[]; recon?: Recon | null; time?: number; track?: Track | null; space?: Recon | null; cal?: Cal }) {
  if (track || space) return <LiveRoom track={track} pins={pins} space={space} cal={cal} />
  if (recon) return (
    <Canvas dpr={[1, 1.75]} camera={{ position: [5, 5, 9], fov: 45 }} gl={{ antialias: true }}>
      <color attach="background" args={["#05060A"]} />
      <Stars radius={70} depth={30} count={1800} factor={3} saturation={0} fade speed={0.5} />
      <ReconScene recon={recon} pins={pins} time={time} />
      <EffectComposer><Vignette eskil={false} offset={0.2} darkness={0.7} /></EffectComposer>
    </Canvas>
  )
  return <SchematicRoom pins={pins} here={here} trail={trail} />
}

function SchematicRoom({ pins, here, trail }: { pins: Pin[]; here: string | null; trail: string[] }) {
  const room = trail.length > 0 || pins.some((p) => p.zone)
  const at = useMemo(() => place(pins, room), [pins, room])
  const last = pins[pins.length - 1]
  const me = here ? ZONE[here] : null
  const focus: [number, number] = last ? at[last.id] : me ? [me.stand[0], me.stand[1]] : [0, 0]
  const walked = useMemo(() => trail.map((id) => ZONE[id]).filter(Boolean).map((z) => [z.stand[0], 0.04, z.stand[1]] as [number, number, number]), [trail])
  const order = useMemo(() => pins.map((p) => [at[p.id][0], 0.04, at[p.id][1]] as [number, number, number]), [pins, at])
  const walls: [number, number, number][][] = [
    [[-8.4, 0, -5], [-1, 0, -5], [-1, 0, 5], [-8.4, 0, 5], [-8.4, 0, -5]],
    [[-0.2, 0, -5], [8.4, 0, -5], [8.4, 0, 5], [-0.2, 0, 5], [-0.2, 0, -5]],
  ]
  return (
    <Canvas dpr={[1, 1.75]} camera={{ position: [4, 10, 14], fov: 40 }} gl={{ antialias: true }}>
      <color attach="background" args={["#05060A"]} />
      <fog attach="fog" args={["#05060A", 18, 42]} />
      <Stars radius={60} depth={30} count={2200} factor={3} saturation={0} fade speed={0.6} />
      <Sparkles count={70} scale={[20, 6, 14]} position={[0, 3, 0]} size={2} speed={0.25} opacity={0.5} color={GLOW} />
      <gridHelper args={[60, 60, "#1B2140", "#10142A"]} position={[0, -0.02, 0]} />
      {room && (
        <>
          {walls.map((w, i) => (
            <group key={i}>
              <Line points={w} color={GLOW} lineWidth={1.6} transparent opacity={0.9} />
              <Line points={w.map(([x, , z]) => [x, 1.6, z] as [number, number, number])} color={GLOW} lineWidth={1} transparent opacity={0.22} />
              {w.slice(0, 4).map(([x, , z], k) => <Line key={k} points={[[x, 0, z], [x, 1.6, z]]} color={GLOW} lineWidth={1} transparent opacity={0.22} />)}
            </group>
          ))}
          {ZONES.map((z) => (
            <group key={z.id} position={[z.stand[0], 0, z.stand[1]]}>
              <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}><circleGeometry args={[0.09, 20]} /><meshBasicMaterial color={z.id === here ? INK : DIM} /></mesh>
              <Html center position={[0, 0, 0.6]} distanceFactor={14} style={{ pointerEvents: "none" }}>
                <div style={{ whiteSpace: "nowrap", color: z.id === here ? INK : "#7C849E", font: "500 11px Inter, sans-serif", letterSpacing: "0.02em" }}>{z.name}</div>
              </Html>
            </group>
          ))}
          {walked.length > 1 && <Line points={walked} color={INK} lineWidth={2.5} transparent opacity={0.85} />}
          {me && <Me at={[me.stand[0], me.stand[1]]} />}
        </>
      )}
      {!room && order.length > 1 && <Line points={order} color={INK} lineWidth={2.5} transparent opacity={0.85} />}
      {pins.map((p) => <PinCard key={p.id} pin={p} at={at[p.id]} />)}
      <Rig target={focus} />
      <EffectComposer>
        <Bloom intensity={0.9} luminanceThreshold={0.55} luminanceSmoothing={0.3} mipmapBlur />
        <Vignette eskil={false} offset={0.2} darkness={0.75} />
      </EffectComposer>
    </Canvas>
  )
}

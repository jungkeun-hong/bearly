"use client"

// Bearly stage for the hackathon demo: "See it. Say it. Bought."
// Left: glasses POV (the recorded walk with real Jev boxes, or this computer's camera).
// Middle: a stream of what was seen. Right: what the wearer asked for, with the agent's steps under each ask.
// Real calls: /api/twin/shop (Gemini reads the frame, Shopify catalog search) and /api/twin/pay (Stripe test mode,
// one-time Shared Payment Token). No real money moves and no order is placed with the seller.
// Not connected yet: sending the email. The invoice and report shown here are built from this session's data.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import { ZONES, type Seen } from "./world"
import { loadRecon, type Cal, type Pin, type Recon, type Track as LiveTrack } from "./pin-room"

const PinRoom = dynamic(() => import("./pin-room"), { ssr: false })

type Track = { fps: number; rows: { zone: string | null; objects: Seen["objects"] }[] }
type Offer = { title: string; priceCents: number; seller: string; sellerUrl: string | null; url: string | null; image: string | null }
type Step = { text: string; tag?: string; state: "run" | "done" | "fail" }
type Paid = { id: string; amount: number; via: "spt" | "test_card"; card: { brand: string; last4: string } | null; receiptUrl: string | null; at: string }
type Ask = {
  id: number; t: number; said: string; thumb: string | null
  where?: [number, number] | null // live tracking: the spot on the floor the wearer was looking at when they said it
  shot?: string | null; box?: number[] | null; zone?: string | null // annotated capture: the frame, the thing in it, and where
  depth?: string | null // estimated depth picture of the frame, for the relief card in the 3D view
  reading?: { what: string; value: string; unit: string } | null // a value read or said out loud, kept as data
  kind: "find" | "note" | "email"
  steps: Step[]; offers: Offer[]; pick: number; found: number
  status: "working" | "ready" | "paying" | "paid" | "skipped" | "noted" | "failed"
  paid: Paid | null
}
type SeenRow = { key: number; t: number; label: string; thumb: string | null }

const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} S`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const typing = (text: string) => sleep(Math.min(520, text.length * 5) + 120) // time for a line to finish typing
const post = async (url: string, body: unknown) => { const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { ok: r.ok, d: await r.json() } }

/** Types a line out, a few characters at a time, each time the text changes. */
function Typed({ text }: { text: string }) {
  const [n, setN] = useState(0)
  useEffect(() => {
    setN(0)
    const id = setInterval(() => setN((x) => { if (x >= text.length) { clearInterval(id); return x } return x + 3 }), 12)
    return () => clearInterval(id)
  }, [text])
  return <>{text.slice(0, n)}</>
}

const LIVE_PROMPT = `You are Bearly, a quick, warm shopping assistant living in the user's camera glasses. You hear them and you see what they see: you get one video frame a second.
Talk like a friend standing next to them. English only. One short sentence whenever you can, two at most. Plain speech: no lists, no markdown, never read out a long product title.
Never say something is found, bought, drafted or shown unless the tool result for it has come back. Only say you are working on it while a tool call is actually running.
Do not end a question with a tag like "okay?" or "confirm?"; ask it plainly.
If you did not catch something, ask about the nearest likely meaning in a few words.
When they show, hold up or point at something and want to know what it is, what it costs, or want one: say in a few words what you see (read the brand and name off the label), then call find_product with a precise shopping query (brand, product name, size or colour). Do not ask them to describe it; look.
After find_product returns, check the titles. Position 1 is the cheapest but may be a part, an accessory or a wrongly priced listing. If it is not the same kind of product they showed, call select_offer with the cheapest position that is. Then say that price and seller in one sentence and ask if they want it. If nothing is the exact product, say it is the closest match.
Prices, sellers and totals come only from tool results. Never make one up.
Buy only after a clear yes to a specific offer. Then call buy_selected at once, without talking first, and confirm the amount in a few words when it returns. If they want a different one, call next_offer. If they say no, call skip_offer.
If they ask to email their manager the invoice or report, call email_manager and say it is drafted on screen. If they ask to see the invoice, the report, or the board (also called canvas, dashboard, or everything you saw), call show_document. If they say close it, call close_document.
If they say something about the condition of equipment that belongs in an inspection report, call add_note and acknowledge in two or three words.
If they are just chatting or testing the mic, chat back briefly. If you did not catch it, say so in a few words.`
const LIVE_TOOLS = [
  { name: "find_product", description: "Search real shops for the product the user is showing or asking about. Returns offers sorted by price, and puts them on the user's screen.", parameters: { type: "OBJECT", properties: { query: { type: "STRING", description: "Shopping search query: brand, product name, size or colour, 3 to 8 words" } }, required: ["query"] } },
  { name: "select_offer", description: "Put a specific offer from the last find_product result on screen as the selected one. Use it when position 1 is not really the product the user showed.", parameters: { type: "OBJECT", properties: { position: { type: "NUMBER", description: "Position in offers_cheapest_first, starting at 1" } }, required: ["position"] } },
  { name: "next_offer", description: "Select the next offer in the open list and show it." },
  { name: "buy_selected", description: "Pay for the currently selected offer. Only after the user clearly said yes." },
  { name: "skip_offer", description: "Dismiss the open offer because the user does not want it." },
  { name: "email_manager", description: "Draft the email to the user's manager with the invoice and the walk report attached, and show it on screen." },
  { name: "show_document", description: "Show something large on screen: the invoice, the walk report, or the board (one canvas with everything seen, asked and bought in this session).", parameters: { type: "OBJECT", properties: { which: { type: "STRING", enum: ["invoice", "report", "board"] } }, required: ["which"] } },
  { name: "close_document", description: "Close the document that is showing." },
  { name: "add_note", description: "Write an observation about equipment into the walk report.", parameters: { type: "OBJECT", properties: { text: { type: "STRING" } }, required: ["text"] } },
] as never[]

const READING_PROMPT = `
You also keep readings so nobody writes anything down. When they say a value out loud (a pressure, a temperature, a size, a model or serial number, a count) or ask you to read one off a gauge, nameplate or label in view, call record_reading with what it is, the value and the unit, then confirm it back in a few words. Read a value yourself only when you can clearly see it; if you cannot, say so and ask them to say it. Never estimate a measurement from the picture.`
const READING_TOOL = { name: "record_reading", description: "Save one value the user said or that is clearly readable in view (gauge, nameplate, label, size). It is pinned on the photo of what they are looking at.", parameters: { type: "OBJECT", properties: { what: { type: "STRING", description: "What the value is, e.g. discharge pressure, filter size, motor model" }, value: { type: "STRING" }, unit: { type: "STRING", description: "psi, °F, in, hp. Empty for a model or serial number." }, on: { type: "STRING", description: "The physical thing the value is on or about, as it looks in view, e.g. pressure gauge, pump nameplate, filter housing" } }, required: ["what", "value", "on"] } } as never

// Before the phone sends any position, the demo still shows the wearer standing at the start point.
const IDLE_TRACK: LiveTrack = { pos: [0, 0], heading: 0, head: { yaw: 0, pitch: 0 }, path: [[0, 0]], steps: 0 }

const QUICK = ["Find me the cheapest one of these", "Show me the next one", "Buy it", "Buy it, then email my manager the invoice and the report", "Show me the invoice"]

export default function ReportApp({ annotate = false, spatial = false, demo = false }: { annotate?: boolean; spatial?: boolean; demo?: boolean } = {}) {
  const video = useRef<HTMLVideoElement>(null)
  const rec = useRef<{ stop: () => void } | null>(null)
  const lastSeen = useRef<Record<string, number>>({})
  const nextId = useRef(1)
  const asksRef = useRef<Ask[]>([])
  const [now, setNow] = useState(0)
  const [track, setTrack] = useState<Track | null>(null)
  const [camera, setCamera] = useState(false)
  const [seenLog, setSeenLog] = useState<SeenRow[]>([])
  const [asks, setAsks] = useState<Ask[]>([])
  const [reply, setReply] = useState("")
  const [text, setText] = useState("")
  const [listening, setListening] = useState(false)
  const [live, setLive] = useState<Seen["objects"]>([])
  const [named, setNamed] = useState<{ query: string; at: number } | null>(null) // what Gemini last read in the camera frame
  const namedRef = useRef<{ query: string; at: number } | null>(null)
  const [hearing, setHearing] = useState("") // words the mic is hearing right now, before the sentence is final
  const saidRef = useRef("")
  const [said, setSaid] = useState("") // last thing the wearer said, for the caption
  const speaking = useRef(false) // true while the assistant's voice plays, so the mic does not hear it
  const liveSession = useRef<{ close: () => void; text: (t: string) => void } | null>(null) // the Gemini Live session, when on
  const liveOn = useRef(false)
  const paidCount = useRef(0)
  const toolsRef = useRef<Record<string, (args: Record<string, unknown>) => Promise<unknown>>>({})
  const [recon, setRecon] = useState<Recon | null>(null) // real 3D points and camera path of the recorded walk, if the file is there
  useEffect(() => { if (spatial && !demo) void loadRecon("/twin-local/recon.json").then(setRecon) }, [spatial, demo]) // the demo has no recorded walk
  const [livePos, setLivePos] = useState<LiveTrack | null>(null) // live position and head direction from the phone app, when connected
  const trackRef = useRef<LiveTrack | null>(null)
  // The real space, rebuilt from a phone video of the room (public/twin-local/recon-yc.json). Shown behind live tracking on a
  // camera or the glasses. `cal` lays it over the tracking by hand: turn, size, shift. Saved in this browser.
  const [space, setSpace] = useState<Recon | null>(null)
  const [cal, setCal] = useState<Cal>({ yaw: 0, scale: 1, x: 0, z: 0 })
  useEffect(() => {
    if (!spatial) return
    void loadRecon("/twin-local/recon-yc.json").then(setSpace)
    try { const saved = localStorage.getItem("vb-cal"); if (saved) setCal(JSON.parse(saved)) } catch { /* no saved calibration */ }
  }, [spatial])
  const nudge = (f: (c: Cal) => Cal) => setCal((c) => { const n = f(c); try { localStorage.setItem("vb-cal", JSON.stringify(n)) } catch { /* private window */ } return n })
  const [trail, setTrail] = useState<string[]>([]) // zones walked through, in order (recorded walk only)
  const [echoGate, setEchoGate] = useState(true) // do not send the mic while the assistant is talking (for loudspeakers)
  const echoGateRef = useRef(true)
  useEffect(() => { echoGateRef.current = echoGate }, [echoGate])
  const cutIn = useRef<() => void>(() => {}) // stops the assistant mid-sentence and opens the mic again
  const glasses = useRef<{ audio: MediaStreamTrack | null; leave: () => void } | null>(null) // glasses feed over LiveKit
  const [source, setSource] = useState<"walk" | "camera" | "glasses">("walk")
  const [micLevel, setMicLevel] = useState("")
  // Hold-to-talk: in a loud room the mic cannot tell the wearer from the crowd, so the assistant only listens while Space
  // (or the on-screen button) is held. Letting go is the end of the sentence, so the answer starts sooner too.
  const [ptt, setPtt] = useState(false)
  const pttRef = useRef(false), held = useRef(false)
  useEffect(() => { pttRef.current = ptt; held.current = false }, [ptt])
  const [liveState, setLiveState] = useState<"off" | "connecting" | "on">("off")
  const [mic, setMic] = useState("off") // what the speech recogniser last reported, shown under the input
  const [zoom, setZoom] = useState<"invoice" | "report" | "board" | null>(null)

  useEffect(() => { asksRef.current = asks }, [asks])
  useEffect(() => { if (demo) return; fetch("/twin-local/track.json").then((r) => (r.ok ? r.json() : null)).then((t) => setTrack(t && Array.isArray(t.rows) ? t : null)).catch(() => setTrack(null)) }, [])
  useEffect(() => {
    const id = setInterval(() => { const v = video.current; if (v) setNow(v.currentTime) }, 100)
    return () => clearInterval(id)
  }, [])

  const row = track && !camera ? track.rows[Math.min(Math.floor(now * track.fps), track.rows.length - 1)] : null
  const seeing = useMemo(() => {
    const all = (camera ? live : row?.objects ?? []).filter((o) => o.label !== "hand")
    const product = named && all.find((o) => o.label === named.query)
    return product ? all.filter((o) => o === product || !["item", "logo", "bottle", "cup"].includes(o.label)) : all
  }, [row, camera, live, named])

  // One square crop of the current frame, around a box when there is one.
  const crop = useCallback((box?: number[], size = 160): string | null => {
    const v = video.current
    if (!v || !v.videoWidth) return null
    const c = document.createElement("canvas")
    c.width = size; c.height = size
    const W = v.videoWidth, H = v.videoHeight
    let s = Math.min(W, H), sx = (W - s) / 2, sy = (H - s) / 2
    if (box) {
      const cx = ((box[1] + box[3]) / 2000) * W, cy = ((box[0] + box[2]) / 2000) * H
      s = Math.min(W, H, Math.max(((box[3] - box[1]) / 1000) * W, ((box[2] - box[0]) / 1000) * H) * 1.3)
      sx = Math.min(Math.max(0, cx - s / 2), W - s); sy = Math.min(Math.max(0, cy - s / 2), H - s)
    }
    try { c.getContext("2d")?.drawImage(v, sx, sy, s, s, 0, 0, size, size); return c.toDataURL("image/jpeg", 0.8) } catch { return null }
  }, [])
  const frame = useCallback((width = 640): string | null => {
    const v = video.current
    if (!v || !v.videoWidth) return null
    const c = document.createElement("canvas")
    c.width = width; c.height = Math.round((640 * v.videoHeight) / v.videoWidth)
    try { c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height); return c.toDataURL("image/jpeg", 0.8) } catch { return null }
  }, [])

  // Seen stream: a new line each time something comes into view after being out of view for a few seconds.
  useEffect(() => {
    if (!camera && now < 0.5) { lastSeen.current = {}; setSeenLog([]); return }
    const fresh: SeenRow[] = []
    for (const o of seeing) {
      const prev = lastSeen.current[o.label]
      if (prev === undefined || now - prev > 4) fresh.push({ key: Math.round(now * 10) * 100 + fresh.length, t: now, label: o.label, thumb: crop(o.box, 200) })
      lastSeen.current[o.label] = now
    }
    if (fresh.length) setSeenLog((l) => [...fresh, ...l].slice(0, 40))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Math.floor(now * 2), camera])

  // Camera mode: ask Jev about the current frame, again as soon as the last answer is back.
  useEffect(() => {
    if (!camera) { setLive([]); return }
    let alive = true
    void (async () => {
      while (alive) {
        const f = frame()
        if (f) {
          try { const { ok, d } = await post("/api/twin/see", { frame: f, mode: "wear", track: namedRef.current && Date.now() - namedRef.current.at < 20000 ? namedRef.current.query : undefined }); if (alive && ok) setLive(d.objects ?? []) } catch { /* next frame */ }
        }
        await sleep(f ? 120 : 400)
      }
    })()
    return () => { alive = false }
  }, [camera, frame])

  const seeingRef = useRef(seeing)
  useEffect(() => { seeingRef.current = seeing }, [seeing])
  useEffect(() => { namedRef.current = named }, [named])
  useEffect(() => { if (!camera) setNamed(null) }, [camera])
  // Jev finds things by category ("item", "logo") but cannot read a brand. So while something is held up or a logo is in
  // view, Gemini reads what it is, at most once every three seconds, and Jev then follows that exact product by name.
  // A find_product call sets the same name, so this stays quiet for a while after one.
  useEffect(() => {
    if (!camera) return
    let alive = true
    void (async () => {
      while (alive) {
        const labels = seeingRef.current.map((o) => o.label)
        const fresh = namedRef.current && Date.now() - namedRef.current.at < 6000
        const worth = labels.some((l) => l === "item" || l === "logo" || l === "bottle" || l === "cup")
        const f = worth && !fresh ? frame() : null
        if (f) {
          try {
            const { ok, d } = await post("/api/twin/shop", { said: "What is this product?", frame: f, hint: labels.join(", "), lookOnly: true })
            if (alive && ok && d.query && d.steps?.some((x: { step: string; note?: string }) => x.step === "look" && !x.note)) setNamed({ query: d.query, at: Date.now() })
          } catch { /* next round */ }
        }
        await sleep(3000)
      }
    })()
    return () => { alive = false }
  }, [camera, frame])

  const patch = (id: number, f: (a: Ask) => Ask) => setAsks((l) => l.map((a) => (a.id === id ? f(a) : a)))
  /** Where a named thing is in the current frame: a detected label that the name contains, else one Jev call for that exact name. */
  const locate = async (name: string): Promise<number[] | null> => {
    const lower = name.toLowerCase()
    const known = seeingRef.current.find((o) => lower.includes(o.label.toLowerCase()))
    if (known) return known.box
    const f = frame()
    if (!f) return null
    try {
      const { ok, d } = await post("/api/twin/see", { frame: f, mode: "wear", track: name })
      return ok ? (d.objects as Seen["objects"]).find((o) => o.label === name)?.box ?? null : null
    } catch { return null }
  }
  const add = (said: string, kind: Ask["kind"], status: Ask["status"], steps: Step[] = [], reading: Ask["reading"] = null, at: number[] | null = null) => {
    // The thing this is about: a box the caller already found, else the product Jev is tracking by name, else the most prominent thing in view.
    const focus = at ? { box: at } : seeing.find((o) => o.label === namedRef.current?.query) ?? seeing[0]
    const ask: Ask = {
      id: nextId.current++, t: now, said, thumb: crop(focus?.box), kind, steps, offers: [], pick: 0, found: 0, status, paid: null, reading,
      ...(annotate ? { shot: kind === "email" ? null : frame(768), box: focus?.box ?? null, zone: row?.zone ?? null } : {}),
      // Live tracking: pin it 1.5 m ahead of the wearer, in the direction the glasses are facing.
      ...(trackRef.current ? (() => { const k = trackRef.current!, a = k.heading + k.head.yaw; return { where: [k.pos[0] + Math.sin(a) * 1.5, k.pos[1] - Math.cos(a) * 1.5] as [number, number] } })() : {}),
    }
    setAsks((l) => [ask, ...l])
    // 3D view: ask the local depth service for this frame. If it is not running the card just stays flat.
    if (spatial && ask.shot) void post("/api/twin/depth", { frame: ask.shot }).then(({ ok, d }) => { if (ok && d.depth) patch(ask.id, (a) => ({ ...a, depth: d.depth })) }).catch(() => {})
    return ask
  }

  // In a live voice session the model speaks for itself, so the page's own canned replies stay quiet.
  const say = (t: string) => { if (!liveOn.current) setReply(t) }

  const find = async (said: string) => {
    const ask = add(said, "find", "working", [{ text: "Looking…", state: "run" }])
    const steps: Step[] = []
    const show = async (extra?: Step) => { patch(ask.id, (a) => ({ ...a, steps: extra ? [...steps, extra] : [...steps] })); await typing((extra ?? steps[steps.length - 1]).text) }
    try {
      const known = namedRef.current && Date.now() - namedRef.current.at < 5000 ? namedRef.current.query : null
      const look = known ? { ok: true, d: { query: known, steps: [] as { step: string; ms: number }[] } }
        : await post("/api/twin/shop", { said, frame: frame(), hint: seeing.map((o) => o.label).join(", ") || null, lookOnly: true })
      if (!look.ok) throw new Error(look.d.error || "I could not tell what item you mean.")
      const lookMs = look.d.steps?.find((x: { step: string }) => x.step === "look")?.ms
      steps.push({ text: look.d.query, tag: known ? "GEMINI · ALREADY READ" : lookMs ? `GEMINI · ${secs(lookMs)}` : undefined, state: "done" })

      const shopping = post("/api/twin/shop", { query: look.d.query })
      await show({ text: "Searching Shopify…", state: "run" })
      const { ok, d } = await shopping
      if (!ok || !d.offers?.length) throw new Error(d.error || `I searched for “${look.d.query}” and found nothing in stock.`)
      const shopMs = d.steps?.find((x: { step: string }) => x.step === "shopify")?.ms
      say(`Cheapest is ${usd(d.offers[0].priceCents)} from ${d.offers[0].seller}. Buy it?`)
      steps.push({ text: `${d.total ?? d.found} offers`, tag: shopMs ? `SHOPIFY · ${secs(shopMs)}` : "SHOPIFY", state: "done" })
      await show()
      patch(ask.id, (a) => ({ ...a, offers: d.offers, found: d.found, status: "ready" }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : "The search failed."
      patch(ask.id, (a) => ({ ...a, steps: [...steps, { text: msg, state: "fail" }], status: "failed" }))
      say(msg)
    }
  }

  const pay = async (ask: Ask): Promise<Paid | null> => {
    const offer = ask.offers[ask.pick]
    const before = ask.steps.filter((s) => s.state === "done")
    patch(ask.id, (a) => ({ ...a, status: "paying", steps: [...before, { text: `Paying ${usd(offer.priceCents)}…`, state: "run" }] }))
    try {
      const r = await fetch("/api/twin/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: offer.title, amountCents: offer.priceCents, seller: offer.seller }) })
      const d = await r.json()
      if (!r.ok || !d.paid) throw new Error(d.error || "Stripe did not take the payment.")
      const tok = d.steps?.find((s: { step: string; ok: boolean }) => s.step === "token" && s.ok)
      const chg = d.steps?.find((s: { step: string; ok: boolean }) => s.step !== "token" && s.ok)
      const card = d.card ? `${d.card.brand[0].toUpperCase()}${d.card.brand.slice(1)} ${d.card.last4}` : "the test card"
      const steps: Step[] = d.via === "spt"
        ? [
            { text: `One-time token, max ${usd(offer.priceCents)}`, tag: tok ? `STRIPE · ${secs(tok.ms)}` : "STRIPE", state: "done" },
            { text: `Paid · ${card}`, tag: chg ? `STRIPE · TEST · ${secs(chg.ms)}` : "STRIPE · TEST", state: "done" },
          ]
        : [{ text: `Paid · ${card}`, tag: chg ? `STRIPE · TEST · ${secs(chg.ms)}` : "STRIPE · TEST", state: "done" }]
      const paid: Paid = { id: d.id, amount: d.amount, via: d.via, card: d.card, receiptUrl: d.receiptUrl, at: new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) }
      say(`Paid. ${usd(offer.priceCents)} to ${offer.seller}.`)
      paidCount.current++
      const settle = async () => {
        for (let k = 1; k <= steps.length; k++) { patch(ask.id, (a) => ({ ...a, steps: [...before, ...steps.slice(0, k)] })); await typing(steps[k - 1].text) }
        await sleep(500)
        patch(ask.id, (a) => ({ ...a, status: "paid", paid }))
      }
      if (liveOn.current) void settle(); else await settle()
      return paid
    } catch (e) {
      const msg = e instanceof Error ? e.message : "The payment failed."
      patch(ask.id, (a) => ({ ...a, steps: [...before, { text: msg, state: "fail" }], status: "ready" }))
      say(msg)
      return null
    }
  }

  const email = async (said: string, justPaid = 0) => {
    const bought = Math.max(asksRef.current.filter((a) => a.paid).length + justPaid, paidCount.current)
    const notes = asksRef.current.filter((a) => a.kind === "note").length
    const steps: Step[] = [
      { text: "Invoice", tag: "STRIPE", state: "done" },
      { text: `Report · ${notes} ${notes === 1 ? "note" : "notes"}, ${bought} bought`, tag: "REPORT", state: "done" },
    ]
    const ask = add(said, "email", "working", [{ text: "Building invoice and report…", state: "run" }])
    await sleep(700)
    for (let k = 1; k <= steps.length; k++) { patch(ask.id, (a) => ({ ...a, steps: steps.slice(0, k) })); await typing(steps[k - 1].text) }
    patch(ask.id, (a) => ({ ...a, status: "ready" }))
    say("The email to your manager is ready. Say show me the invoice, or send it.")
  }

  const handle = async (raw: string) => {
    const said = raw.trim()
    if (!said) return
    setText("")
    setSaid(said)
    const s = said.toLowerCase()
    const open = asksRef.current.find((a) => a.kind === "find" && a.status === "ready")
    const anyPaid = asksRef.current.some((a) => a.paid)
    // What do they want? Jev answers in about 0.1 s. If it is unsure or fails, fall back to matching words.
    let intent = "", alsoEmail = /\b(e-?mail|my manager)\b/.test(s)
    try {
      const { ok, d } = await post("/api/twin/intent", { text: said })
      if (ok && d.confidence > 0.5) { intent = d.intent; alsoEmail = alsoEmail || d.alsoEmail }
    } catch { /* word matching below */ }
    if (!intent) {
      intent = /\bshow me the (invoice|receipt)\b/.test(s) ? "invoice" : /\bshow me the report\b/.test(s) ? "report" : /\b(close|hide) (it|that)\b/.test(s) ? "close"
        : /\b(buy|yes|order it|get it|do it)\b/.test(s) ? "buy" : /\b(next one|another one|show me the next|something else)\b/.test(s) ? "next" : /^(skip|no|never ?mind)\b/.test(s) ? "skip"
        : alsoEmail || /\binvoice\b/.test(s) ? "email" : /\b(find|cheapest|search|look ?up|how much|price|what is)\b/.test(s) ? "find" : "chat"
    }
    if (/^send it\b/.test(s)) { say("Sending email is not connected yet. The email, invoice and report are ready to look at."); return }
    switch (intent) {
      case "invoice": if (anyPaid) { setZoom("invoice"); say("Here is the invoice.") } else say("Nothing is paid yet, so there is no invoice."); return
      case "report": setZoom("report"); say("Here is the walk report."); return
      case "close": setZoom(null); return
      case "buy": {
        if (!open) { say("There is nothing waiting to buy. Show me something and say find it."); return }
        const paid = await pay(open)
        if (paid && alsoEmail) await email(said, 1)
        return
      }
      case "next": {
        if (!open) { say("There is no list open. Show me something and say find it."); return }
        const pick = (open.pick + 1) % open.offers.length
        patch(open.id, (a) => ({ ...a, pick }))
        say(`Next is ${usd(open.offers[pick].priceCents)} from ${open.offers[pick].seller}. Buy it?`)
        return
      }
      case "skip": if (open) { patch(open.id, (a) => ({ ...a, status: "skipped" })); say("Skipped.") } return
      case "email": if (anyPaid) await email(said); else say("Nothing is paid yet. Buy something first, then I can send the invoice."); return
      case "find": await find(said); return
      case "note": add(said, "note", "noted"); say("Noted in the report."); return
      default: say("I'm here. Show me something and say find it.") // small talk, mic tests and unclear words make no card
    }
  }

  // While the mic is on, the assistant says each reply out loud. The mic is deaf while it talks.
  useEffect(() => {
    if (!listening || !reply) return
    let stopped = false
    const audio = new Audio(`/api/twin/speak?text=${encodeURIComponent(reply)}`)
    speaking.current = true
    audio.onended = audio.onerror = () => { setTimeout(() => { if (!stopped) speaking.current = false }, 250) }
    audio.play().catch(() => { speaking.current = false })
    return () => { stopped = true; audio.pause(); speaking.current = false }
  }, [reply, listening])

  // The mic always calls the newest handle, not the one from the render it was switched on in.
  useEffect(() => { if (!said) return; const id = setTimeout(() => setSaid(""), 7000); return () => clearTimeout(id) }, [said])
  const handleRef = useRef(handle)
  useEffect(() => { handleRef.current = handle })

  // Microphone: the page listens itself. It cuts a clip each time you stop talking and sends it to be written down.
  const toggleMic = async () => {
    if (rec.current) { rec.current.stop(); rec.current = null; setListening(false); setMic("off"); setHearing(""); return }
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }) }
    catch { setReply("The microphone is blocked for this page. Allow it in the browser, then press Mic again."); return }
    const device = stream.getAudioTracks()[0]?.label || "microphone"
    const ctx = new AudioContext()
    const meter = ctx.createAnalyser()
    meter.fftSize = 1024
    ctx.createMediaStreamSource(stream).connect(meter)
    const buf = new Float32Array(meter.fftSize)
    let recorder: MediaRecorder | null = null
    let chunks: Blob[] = [], loudTicks = 0, lastLoud = 0, startedAt = 0, floor = 0.01
    const begin = () => {
      chunks = []; loudTicks = 0; startedAt = performance.now()
      const r = new MediaRecorder(stream)
      r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      r.start()
      recorder = r
    }
    const end = (send: boolean) => {
      const r = recorder
      if (!r) return
      recorder = null
      const mine = chunks
      r.onstop = async () => {
        if (!send) return
        setMic("writing down what you said…")
        try {
          const res = await fetch("/api/twin/hear", { method: "POST", headers: { "Content-Type": r.mimeType || "audio/webm" }, body: new Blob(mine, { type: r.mimeType || "audio/webm" }) })
          const d = await res.json()
          if (!res.ok) { setMic(`error: ${d.error}`); return }
          if (!d.text) { setMic(`on · ${device} · heard no words`); return }
          setMic(`heard: “${d.text}” · ${secs(d.ms)}`)
          void handleRef.current(d.text)
        } catch { setMic("error: could not reach the speech service") }
      }
      r.stop()
    }
    begin()
    const timer = setInterval(() => {
      meter.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
      const level = Math.sqrt(sum / buf.length)
      const t = performance.now()
      if (speaking.current) { if (loudTicks) { end(false); begin() } return }
      const loud = level > Math.max(0.03, floor * 4)
      if (!loud) floor = floor * 0.95 + level * 0.05 // slow estimate of the room noise
      if (loud) { loudTicks++; lastLoud = t; if (loudTicks === 6) { setHearing("…"); setMic(`hearing speech · ${device}`) } }
      const quietFor = t - lastLoud
      if (loudTicks >= 6 && (quietFor > 500 || t - startedAt > 15000)) { setHearing(""); end(true); begin() }
      else if (loudTicks < 6 && t - startedAt > 5000) { end(false); begin(); setMic(`on · ${device} · level ${Math.round(level * 1000)}`) }
    }, 50)
    setMic(`on · ${device}`)
    setListening(true)
    rec.current = { stop: () => { clearInterval(timer); end(false); stream.getTracks().forEach((x) => x.stop()); void ctx.close() } }
  }

  // ── Live voice: one Gemini Live session hears the mic, sees the camera, talks back and calls these tools. ──
  const openOffer = () => asksRef.current.find((a) => a.kind === "find" && a.offers.length > 0 && !a.paid && a.status !== "skipped" && a.status !== "failed")
  const brief = (o: Offer) => ({ title: o.title, price: usd(o.priceCents), seller: o.seller })
  const liveFind = async (query: string, saidNow: string) => {
    setNamed({ query, at: Date.now() }) // Jev now follows this exact thing in the camera view
    const steps: Step[] = [{ text: query, tag: "GEMINI LIVE", state: "done" }]
    const ask = add(saidNow || `Find ${query}`, "find", "working", [...steps, { text: "Searching Shopify…", state: "run" }])
    const { ok, d } = await post("/api/twin/shop", { query })
    if (!ok || !d.offers?.length) {
      patch(ask.id, (a) => ({ ...a, steps: [...steps, { text: d.error || `I searched for “${query}” and found nothing in stock.`, state: "fail" }], status: "failed" }))
      return { found: 0, error: d.error || "nothing in stock matched" }
    }
    const shopMs = d.steps?.find((x: { step: string }) => x.step === "shopify")?.ms
    steps.push({ text: `${d.total ?? d.found} offers`, tag: shopMs ? `SHOPIFY · ${secs(shopMs)}` : "SHOPIFY", state: "done" })
    patch(ask.id, (a) => ({ ...a, steps: [...steps], offers: d.offers, found: d.found }))
    void (async () => { await typing(steps[1].text); patch(ask.id, (a) => (a.status === "working" ? { ...a, status: "ready" } : a)) })()
    return {
      found: d.total ?? d.found, on_screen_now: 1,
      offers_cheapest_first: (d.offers as Offer[]).map((o, k) => ({ position: k + 1, ...brief(o) })),
      note: "Position 1 is on screen. Cheapest is not always right: some listings are parts, accessories or priced wrongly. If position 1 is not the same kind of product the user showed, call select_offer with the cheapest position that is, before you say a price.",
    }
  }
  toolsRef.current = {
    find_product: async (a) => liveFind(String(a.query ?? "").slice(0, 80), saidRef.current),
    select_offer: async (a) => {
      const o = openOffer()
      if (!o) return { error: "no offers are open" }
      const pick = Math.min(o.offers.length, Math.max(1, Math.round(Number(a.position) || 1))) - 1
      patch(o.id, (x) => ({ ...x, pick }))
      return { on_screen_now: pick + 1, selected: brief(o.offers[pick]) }
    },
    next_offer: async () => {
      const o = openOffer()
      if (!o) return { error: "no offers are open" }
      const pick = (o.pick + 1) % o.offers.length
      patch(o.id, (x) => ({ ...x, pick }))
      return { selected: brief(o.offers[pick]), position: `${pick + 1} of ${o.offers.length}` }
    },
    buy_selected: async () => {
      const o = openOffer()
      if (!o) return { paid: false, error: "nothing is selected to buy" }
      const p = await pay(o)
      return p ? { paid: true, amount: usd(p.amount), item: o.offers[o.pick].title, seller: o.offers[o.pick].seller, card: p.card ? `${p.card.brand} ending ${p.card.last4}` : "test card", mode: "Stripe test mode, no real money moved" } : { paid: false, error: "the payment did not go through" }
    },
    skip_offer: async () => { const o = openOffer(); if (o) patch(o.id, (x) => ({ ...x, status: "skipped" })); return { skipped: !!o } },
    email_manager: async () => {
      if (!paidCount.current) return { error: "nothing is paid yet, so there is no invoice" }
      void email(saidRef.current || "Email my manager the invoice and the report")
      return { drafted: true, attachments: ["Invoice.pdf", "Walk report.pdf"], sent: false, note: "The email is drafted on screen. Actually sending it is not connected yet." }
    },
    show_document: async (a) => { if (a.which === "board") { setZoom("board"); return { showing: "board of everything seen, asked and bought in this session" } }; const which = a.which === "report" ? "report" : "invoice"; if (which === "invoice" && !paidCount.current) return { error: "nothing is paid yet" }; setZoom(which); return { showing: which } },
    close_document: async () => { setZoom(null); return { closed: true } },
    add_note: async (a) => { add(String(a.text ?? saidRef.current), "note", "noted"); return { noted: true } },
    record_reading: async (a) => {
      const reading = { what: String(a.what ?? "").slice(0, 60), value: String(a.value ?? "").slice(0, 30), unit: String(a.unit ?? "").slice(0, 12) }
      if (!reading.what || !reading.value) return { error: "what and value are required" }
      const on = String(a.on ?? "").slice(0, 60)
      add(saidRef.current || `${reading.what}: ${reading.value} ${reading.unit}`.trim(), "note", "noted", [], reading, on ? await locate(on) : null)
      return { recorded: reading, pinned_on_photo: true }
    },
  }

  const toggleLive = async (useFallback = false) => {
    if (liveSession.current) { liveSession.current.close(); return }
    if (rec.current) { rec.current.stop(); rec.current = null; setListening(false) }
    setLiveState("connecting"); setMic("live: connecting…")
    try {
      const tk = await fetch("/api/twin/live-token").then((r) => r.json())
      if (!tk.token) throw new Error(tk.error || "no token")
      const { GoogleGenAI, Modality } = await import("@google/genai")
      const ai = new GoogleGenAI({ apiKey: tk.token, httpOptions: { apiVersion: "v1alpha" } })
      const out = new AudioContext({ sampleRate: 24000 })
      const playing = new Set<AudioBufferSourceNode>()
      const model: string = useFallback ? tk.fallbackModel : tk.model
      let playAt = 0, closed = false, newIn = true, newOut = true, turnIn = "", turnOut = ""
      let dropTurn = false // after a manual cut-in, the rest of what it was saying is thrown away
      let heardAt = 0, toolAt = 0, chime: OscillatorNode | null = null // for timing a turn and the waiting sound
      // A soft tone while a tool runs, so a pause never sounds like the assistant died. Stops at its first word.
      const chimeOff = () => { try { chime?.stop() } catch { /* already stopped */ } chime = null }
      const chimeOn = () => {
        if (chime) return
        const o = out.createOscillator(), g = out.createGain()
        o.frequency.value = 440; g.gain.value = 0
        g.gain.linearRampToValueAtTime(0.03, out.currentTime + 0.1)
        o.connect(g); g.connect(out.destination); o.start()
        chime = o
        setTimeout(() => { if (chime === o) chimeOff() }, 15000)
      }
      const hush = () => { playing.forEach((x) => { try { x.stop() } catch { /* already stopped */ } }); playing.clear(); playAt = 0 }
      const play = (b64: string) => {
        const bin = atob(b64), n = bin.length >> 1
        if (!n) return
        const buf = out.createBuffer(1, n, 24000), ch = buf.getChannelData(0)
        for (let i = 0; i < n; i++) { const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); ch[i] = (v >= 32768 ? v - 65536 : v) / 32768 }
        const src = out.createBufferSource()
        src.buffer = buf; src.connect(out.destination)
        const t = Math.max(out.currentTime + 0.03, playAt)
        src.start(t); playAt = t + buf.duration
        playing.add(src); src.onended = () => playing.delete(src)
      }
      let remoteSink: HTMLAudioElement | null = null, micPeak = 0
      let micStream: MediaStream | null = null, micCtx: AudioContext | null = null, frames: ReturnType<typeof setInterval> | null = null
      const close = () => {
        if (closed) return
        closed = true; hush(); chimeOff()
        if (frames) clearInterval(frames)
        if (remoteSink) { remoteSink.pause(); remoteSink.srcObject = null }
        micStream?.getTracks().forEach((x) => x.stop()); void micCtx?.close(); void out.close()
        try { session.close() } catch { /* already closed */ }
        liveSession.current = null; liveOn.current = false; setLiveState("off"); setMic("off")
      }
      const session = await ai.live.connect({
        model,
        // Voice settings that work well for a noisy room:
        // low temperature, speech start not triggered by room noise, a turn ends after 0.6 s of silence, and a sliding
        // context window, without which a session with audio and video dies after about two minutes.
        config: {
          responseModalities: [Modality.AUDIO], systemInstruction: annotate ? LIVE_PROMPT + READING_PROMPT : LIVE_PROMPT, tools: [{ functionDeclarations: annotate ? [...LIVE_TOOLS, READING_TOOL] : LIVE_TOOLS }],
          inputAudioTranscription: {}, outputAudioTranscription: {}, speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: tk.voice } } },
          temperature: 0.3,
          realtimeInputConfig: { automaticActivityDetection: { startOfSpeechSensitivity: "START_SENSITIVITY_LOW" as never, endOfSpeechSensitivity: "END_SENSITIVITY_HIGH" as never, prefixPaddingMs: 40, silenceDurationMs: 380 } },
          contextWindowCompression: { triggerTokens: "16384", slidingWindow: { targetTokens: "8192" } },
        },
        callbacks: {
          onmessage: (m) => {
            const sc = m.serverContent
            if (sc?.interrupted) { hush(); chimeOff() }
            if (sc?.turnComplete || sc?.interrupted) dropTurn = false
            if (sc?.inputTranscription?.text) { if (newIn) { turnIn = ""; newIn = false }; turnIn += sc.inputTranscription.text; heardAt = performance.now(); saidRef.current = turnIn.trim(); setSaid(turnIn.trim()) }
            if (sc?.outputTranscription?.text) { if (newOut) { turnOut = ""; newOut = false }; turnOut += sc.outputTranscription.text; setReply(turnOut.trim()) }
            for (const part of sc?.modelTurn?.parts ?? []) if (part.inlineData?.data && !dropTurn) {
              chimeOff()
              if (heardAt) { const ms = Math.round(performance.now() - heardAt); console.log(`[vb] turn: ${ms} ms from last heard word to first sound${toolAt ? `, tool took ${toolAt} ms` : ""}`); setMic(`live · ${model} · answered in ${secs(ms)}`); heardAt = 0; toolAt = 0 }
              play(part.inlineData.data)
            }
            if (sc?.turnComplete) { newIn = true; newOut = true }
            const calls = m.toolCall?.functionCalls
            if (calls?.length) newOut = true // what it says after a tool call replaces what it said before
            if (calls?.length) void (async () => {
              const functionResponses = []
              const t0 = performance.now()
              const wait = setTimeout(chimeOn, 350) // only tools that take a moment get the tone
              for (const c of calls) {
                let response: unknown
                try { response = await (toolsRef.current[c.name ?? ""]?.((c.args ?? {}) as Record<string, unknown>) ?? Promise.resolve({ error: "unknown tool" })) } catch (e) { response = { error: e instanceof Error ? e.message : "the tool failed" } }
                console.log("[vb] tool", c.name, c.args, "→", response)
                functionResponses.push({ id: c.id, name: c.name, response: response as Record<string, unknown> })
              }
              clearTimeout(wait); toolAt = Math.round(performance.now() - t0)
              if (!closed) session.sendToolResponse({ functionResponses })
            })()
          },
          onerror: (e) => { setMic(`live error: ${e.message || "connection problem"}`) },
          // A dropped session comes straight back, once, on the fallback model. What was asked and bought stays on screen.
          onclose: (e) => { if (!closed) { close(); if (!useFallback) { setMic(`live dropped${e.reason ? ` (${e.reason})` : ""}, reconnecting…`); void toggleLive(true) } else setMic(`live closed${e.reason ? `: ${e.reason}` : ""}`) } },
        },
      })
      cutIn.current = () => { if (playing.size) { dropTurn = true; hush(); chimeOff() } }
      liveOn.current = true
      liveSession.current = { close, text: (t) => { saidRef.current = t; setSaid(t); session.sendClientContent({ turns: [{ role: "user", parts: [{ text: t }] }], turnComplete: true }) } }
      // Eyes: one frame a second of whatever the left pane shows.
      frames = setInterval(() => {
        const f = frame(768)
        if (f && !closed) session.sendRealtimeInput({ video: { data: f.split(",")[1], mimeType: "image/jpeg" } })
        // Once a second: is sound really arriving from the mic? "silent" for long means the mic path is broken.
        if (micStream) { setMicLevel(micPeak === -2 ? "hold Space and talk" : micPeak < 0 ? "not listening while I talk" : micPeak >= 1 ? "hearing you" : micPeak > 0 ? "room noise only, speak up or closer" : "silent"); micPeak = 0 }
      }, 1000)
      // Ears: the microphone as 16 kHz PCM, sent as it is spoken.
      try {
        micStream = glasses.current?.audio && (!demo || prefer.current === "glasses")
          ? new MediaStream([glasses.current.audio.clone()])
          : await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false }) // no auto gain: it pumps the room noise up between words
        // Chrome only lets a remote (WebRTC) audio track flow into Web Audio once it also plays in a media element.
        // Without this the glasses mic arrives as pure silence and the assistant never hears anything. Muted, so no echo.
        if (glasses.current?.audio && (!demo || prefer.current === "glasses")) {
          const sink = new Audio()
          sink.srcObject = micStream; sink.muted = true
          void sink.play().catch(() => {})
          remoteSink = sink
        }
        micCtx = new AudioContext({ sampleRate: 16000 })
        if (micCtx.state !== "running") await micCtx.resume().catch(() => {})
        const proc = micCtx.createScriptProcessor(2048, 1, 1), mute = micCtx.createGain()
        mute.gain.value = 0
        // Sends one buffer of sound, or the same length of silence.
        const sendPcm = (f: Float32Array | null, length: number) => {
          const u = new Uint8Array(length * 2)
          if (f) for (let i = 0; i < length; i++) { const v = Math.max(-1, Math.min(1, f[i])) * 32767; u[2 * i] = v & 255; u[2 * i + 1] = (v >> 8) & 255 }
          let bin = ""
          for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i])
          session.sendRealtimeInput({ audio: { data: btoa(bin), mimeType: "audio/pcm;rate=16000" } })
        }
        let floor = 0.01, openFor = 0, prev: Float32Array | null = null
        proc.onaudioprocess = (e) => {
          if (closed) return
          const f = e.inputBuffer.getChannelData(0)
          let sum = 0
          for (let i = 0; i < f.length; i++) sum += f[i] * f[i]
          const level = Math.sqrt(sum / f.length)
          // Echo gate, as in the production agent: while the assistant talks, and shortly after, the model hears silence
          // instead of the mic, so its own voice from a loudspeaker cannot interrupt it. Space or a tap on the picture cuts in.
          const echo = (demo || echoGateRef.current) && (playing.size > 0 || out.currentTime < playAt + 0.35)
          // Noise gate: in a loud room the model's own speech detector hears the crowd as one endless sentence and never
          // answers. So only sound clearly above the room's steady level is sent; the rest goes out as silence, which gives
          // the model clean gaps to answer in. The room level is tracked slowly, and only while nobody is talking to us.
          const loud = level > Math.max(0.012, floor * 2.6)
          if (!loud) floor = floor * 0.97 + level * 0.03
          if (loud) openFor = 4 // keep sending for about half a second after the voice drops, so word endings are not cut
          else if (openFor > 0) openFor--
          const talking = pttRef.current ? held.current : openFor > 0 && !echo
          if (talking && loud && openFor === 4 && prev && micPeak >= 0) sendPcm(prev, prev.length) // the buffer just before, so the first sound is not clipped
          sendPcm(talking ? f : null, f.length)
          prev = talking ? null : new Float32Array(f)
          if (pttRef.current) micPeak = held.current ? 1 : -2; else if (echo) micPeak = -1; else if (talking) micPeak = Math.max(micPeak, 1); else if (micPeak < 1) micPeak = Math.max(micPeak, level > 0.004 ? 0.5 : 0)
        }
        micCtx.createMediaStreamSource(micStream).connect(proc); proc.connect(mute); mute.connect(micCtx.destination)
        setMic(`live · ${micStream.getAudioTracks()[0]?.label || "microphone"} · ${model}`)
      } catch { setMic("live is on, but the microphone is blocked. Type instead.") }
      setLiveState("on")
    } catch (e) {
      liveSession.current = null; liveOn.current = false; setLiveState("off")
      if (!useFallback) { setMic("live could not start, trying the fallback model…"); void toggleLive(true); return }
      setMic(`live error: ${e instanceof Error ? e.message : "could not start"}`)
    }
  }
  /** Something the wearer said by typing or pressing a button: to the live session when it is on, else to the page's own handler. */
  const send = (t: string) => { if (!t.trim()) return; if (liveSession.current) { setText(""); liveSession.current.text(t.trim()) } else void handle(t) }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); if (!e.repeat) cutIn.current(); held.current = true } }
    const onUp = (e: KeyboardEvent) => { if (e.code === "Space") held.current = false }
    window.addEventListener("keydown", onKey); window.addEventListener("keyup", onUp)
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onUp) }
  }, [])

  // Demo picture: the glasses when they are sending and wanted, otherwise this computer's camera. Never recorded footage.
  const glassesVideo = useRef<MediaStreamTrack | null>(null)
  const macStream = useRef<MediaStream | null>(null)
  const prefer = useRef<"glasses" | "mac">("glasses")
  const [preferUi, setPreferUi] = useState<"glasses" | "mac">("glasses")
  const applySource = async () => {
    const v = video.current
    if (!v) return
    if (prefer.current === "glasses" && glassesVideo.current) {
      macStream.current?.getTracks().forEach((t) => t.stop()); macStream.current = null
      v.removeAttribute("src"); v.srcObject = new MediaStream([glassesVideo.current]); setCamera(true); setSource("glasses"); setSeenLog([]); void v.play()
      return
    }
    try {
      if (!macStream.current) macStream.current = await navigator.mediaDevices.getUserMedia({ video: { width: 1280 }, audio: false })
      if (prefer.current === "glasses" && glassesVideo.current) return void applySource() // the glasses arrived while the camera was opening
      v.removeAttribute("src"); v.srcObject = macStream.current; setCamera(true); setSource("camera"); void v.play()
    } catch { setReply("I could not open this computer's camera. Allow it in the browser, or start the glasses.") }
  }
  const choose = (which: "glasses" | "mac") => { prefer.current = which; setPreferUi(which); void applySource() }
  const demoStarted = useRef(false)
  useEffect(() => {
    if (!demo || demoStarted.current) return
    demoStarted.current = true
    void applySource(); void toggleGlasses()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo])

  // Glasses: watch and hear what the phone app (the Bearly phone app) publishes into the LiveKit room: the glasses camera, the
  // microphone, and small data messages with where the wearer is (phone steps and compass) and how the head is turned
  // (glasses motion sensor). View only, this page publishes nothing.
  const toggleGlasses = async () => {
    const v = video.current
    if (!v) return
    if (glasses.current) { glasses.current.leave(); return }
    try {
      const tk = await fetch("/api/twin/livekit-token").then((r) => r.json())
      if (!tk.token) throw new Error(tk.error || "no token")
      const { Room, RoomEvent, Track } = await import("livekit-client")
      const room = new Room({ adaptiveStream: false })
      const k: LiveTrack = { pos: [0, 0], heading: 0, head: { yaw: 0, pitch: 0 }, path: [[0, 0]], steps: 0 }
      let sensed = false
      const tick = setInterval(() => { if (sensed) { trackRef.current = k; setLivePos({ ...k, head: { ...k.head } }) } }, 100)
      const leave = () => {
        clearInterval(tick); void room.disconnect(); glasses.current = null; trackRef.current = null; setLivePos(null)
        if (demo) { glassesVideo.current = null; void applySource(); return }
        v.srcObject = null; v.src = "/twin-local/pov.mp4"; setCamera(false); setSource("walk"); void v.play()
      }
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Video) (track as unknown as { setPlayoutDelay?: (s: number) => void }).setPlayoutDelay?.(0)
        if (track.kind === Track.Kind.Video && demo) { glassesVideo.current = track.mediaStreamTrack; void applySource(); setMic(`glasses video on · room ${tk.room}`) }
        else if (track.kind === Track.Kind.Video) { v.removeAttribute("src"); v.srcObject = new MediaStream([track.mediaStreamTrack]); setCamera(true); setSource("glasses"); setSeenLog([]); void v.play(); setMic(`glasses video on · room ${tk.room}`) }
        if (track.kind === Track.Kind.Audio && glasses.current) { glasses.current.audio = track.mediaStreamTrack; setMic(`glasses video and mic on · room ${tk.room}. Start Talk live again to use the glasses mic.`) }
      })
      room.on(RoomEvent.DataReceived, (payload) => {
        try {
          const m = JSON.parse(new TextDecoder().decode(payload))
          if (m.type === "pose") {
            sensed = true
            if (m.reset) k.path = [[0, 0]]
            k.pos = [Number(m.x) || 0, Number(m.z) || 0]; k.heading = Number(m.heading) || 0; k.steps = Number(m.steps) || 0
            const last = k.path[k.path.length - 1]
            if (Math.hypot(k.pos[0] - last[0], k.pos[1] - last[1]) > 0.25) k.path = [...k.path.slice(-400), k.pos]
          } else if (m.type === "imu") { sensed = true; k.head = { yaw: Number(m.yaw) || 0, pitch: Number(m.pitch) || 0 } }
        } catch { /* not one of ours */ }
      })
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        if (!demo) return
        if (track.kind === Track.Kind.Video) { glassesVideo.current = null; void applySource(); setMic("the glasses stopped sending video, showing this computer's camera") }
        if (track.kind === Track.Kind.Audio && glasses.current) glasses.current.audio = null
      })
      // In the demo the page stays in the room: if the connection drops it comes back by itself.
      room.on(RoomEvent.Disconnected, () => { if (glasses.current) { leave(); if (demo) setTimeout(() => { if (!glasses.current) void toggleGlasses() }, 3000) } })
      glasses.current = { audio: null, leave }
      await room.connect(tk.url, tk.token)
      setMic(`in room ${tk.room}, waiting for the glasses to publish…`)
    } catch (e) {
      glasses.current = null
      if (demo) { setMic("cannot reach the glasses room yet (network), trying again…"); setTimeout(() => { if (!glasses.current) void toggleGlasses() }, 5000) }
      else setReply(`Could not join the glasses room: ${e instanceof Error ? e.message : "unknown error"}`)
    }
  }

  const toggleCamera = async () => {
    const v = video.current
    if (!v) return
    if (camera) {
      (v.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop())
      v.srcObject = null; v.src = "/twin-local/pov.mp4"; setCamera(false); setSource("walk"); void v.play()
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280 }, audio: false })
      v.removeAttribute("src"); v.srcObject = stream; setCamera(true); setSource("camera"); setSeenLog([]); void v.play()
    } catch { setReply("I could not open the camera.") }
  }

  const lastSaid = said
  const paidAsks = asks.filter((a) => a.paid)
  const total = paidAsks.reduce((s, a) => s + (a.paid?.amount ?? 0), 0)
  const notes = asks.filter((a) => a.kind === "note")

  const Invoice = ({ big }: { big?: boolean }) => (
    <div className={`flex flex-col bg-[#F4F4F2] text-[#0B0B0C] ${big ? "gap-4 rounded-xl p-8 text-sm" : "h-[128px] gap-1 overflow-hidden rounded-md p-2.5 text-[6px] leading-[8px]"}`}>
      <div className="flex items-baseline justify-between"><b className={big ? "text-2xl tracking-[0.06em]" : "text-[9px] tracking-[0.08em]"}>INVOICE</b><span className="text-[#55554F]">Paid · {paidAsks[0]?.paid?.at ?? ""}</span></div>
      <p className="text-[#55554F]">Bill to: Bearly{big && paidAsks[0]?.paid ? ` · Payment ${paidAsks[0].paid.id}` : ""}</p>
      <div className={`flex justify-between bg-[#0B0B0C] font-bold tracking-[0.06em] text-[#F4F4F2] ${big ? "px-3 py-2 text-xs" : "px-1 py-[3px] text-[5px]"}`}><span>ITEM</span><span>AMOUNT</span></div>
      {paidAsks.map((a) => (
        <div key={a.id} className="flex justify-between gap-3"><span>{a.offers[a.pick].title} · {a.offers[a.pick].seller} × 1</span><span className="whitespace-nowrap tabular-nums">{usd(a.paid!.amount)}</span></div>
      ))}
      <div className="h-px bg-[#C9C9C5]" />
      <div className={`flex justify-between font-bold ${big ? "text-lg" : "text-[7px]"}`}><span>Total paid</span><span className="tabular-nums">{usd(total)}</span></div>
      <p className="text-[#8C8C88]">Stripe test mode. No real money moved and no order was placed with the seller.</p>
      {big && paidAsks.map((a) => a.paid?.receiptUrl && <a key={a.id} href={a.paid.receiptUrl} target="_blank" rel="noreferrer" className="w-fit underline">Open the Stripe receipt for {usd(a.paid.amount)}</a>)}
    </div>
  )
  const Report = ({ big }: { big?: boolean }) => (
    <div className={`flex flex-col bg-[#F4F4F2] text-[#0B0B0C] ${big ? "gap-3 rounded-xl p-8 text-sm" : "h-[128px] gap-1 overflow-hidden rounded-md p-2.5 text-[6px] leading-[8px]"}`}>
      <b className={big ? "text-2xl tracking-[0.04em]" : "text-[8px] tracking-[0.06em]"}>WALK REPORT</b>
      <div className={`flex gap-2 bg-[#0B0B0C] font-bold tracking-[0.06em] text-[#F4F4F2] ${big ? "px-3 py-2 text-xs" : "px-1 py-[3px] text-[5px]"}`}><span className={big ? "w-14" : "w-5"}>TIME</span><span className="flex-1">WHAT WAS SAID</span><span className={big ? "w-32" : "w-10"}>RESULT</span></div>
      {[...asks].reverse().filter((a) => a.kind !== "email").map((a) => (
        <div key={a.id} className="flex items-center gap-2 border-b border-[#C9C9C5] pb-1">
          <span className={`tabular-nums ${big ? "w-14" : "w-5"}`}>{clock(a.t)}</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {a.thumb && <img src={a.thumb} alt="" className={`rounded-sm object-cover ${big ? "h-12 w-12" : "h-4 w-4"}`} />}
          <span className="flex-1">{a.said}</span>
          <b className={big ? "w-32" : "w-10"}>{a.paid ? `BOUGHT ${usd(a.paid.amount)}` : a.kind === "note" ? "NOTED" : a.status.toUpperCase()}</b>
        </div>
      ))}
      <p className="text-[#8C8C88]">{notes.length} notes · {paidAsks.length} bought · {seenLog.length} things seen</p>
    </div>
  )

  const here = row?.zone ?? null
  useEffect(() => {
    if (!spatial) return
    if (now < 0.5 && !camera) { setTrail([]); return }
    if (here) setTrail((t) => (t[t.length - 1] === here ? t : [...t, here]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here, spatial, now < 0.5])
  const pins: Pin[] = useMemo(() => [...asks].reverse().filter((a) => a.shot).map((a, k) => {
    const o = a.offers[a.pick]
    return {
      id: a.id, n: k + 1, t: a.t, box: a.box ?? null, where: a.where ?? null, zone: a.zone ?? null, shot: a.shot ?? null, depth: a.depth ?? null, bought: !!a.paid,
      tag: a.reading ? `${a.reading.value} ${a.reading.unit}`.trim() : a.paid ? `Bought ${usd(a.paid.amount)}` : o ? usd(o.priceCents) : "Note",
    }
  }), [asks])

  const chip = "whitespace-nowrap rounded-full border border-[#3A3A3F] px-3.5 py-2 text-sm text-[#B9B9B5]"
  return (
    <main className="vb flex min-h-dvh flex-col gap-4 bg-[#0B0B0C] p-4 font-sans text-[#F4F4F2] lg:h-dvh lg:p-6">
      <style>{`.vb .vb-in{animation:vbin .35s ease-out both}@keyframes vbin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#B9B9B5]">Bearly · {demo ? "Live" : "Live walk"} · Stripe test mode</p>
          <h1 className="text-3xl font-black leading-tight tracking-tight">See it. Say it. Bought.</h1>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button onClick={() => setZoom("board")} className={chip}>Board</button>
          {demo ? (
            <>
              <button onClick={() => choose("glasses")} className={`${chip} ${source === "glasses" ? "!border-[#F4F4F2] !text-[#F4F4F2]" : ""}`}>{source === "glasses" ? "Glasses · live" : preferUi === "glasses" ? "Glasses · waiting" : "Glasses"}</button>
              <button onClick={() => choose("mac")} className={`${chip} ${source === "camera" && preferUi === "mac" ? "!border-[#F4F4F2] !text-[#F4F4F2]" : ""}`}>Mac camera</button>
            </>
          ) : (
            <>
              <button onClick={() => setEchoGate((x) => !x)} title="While the assistant talks it does not hear the mic. Press Space or tap the picture to cut in." className={chip}>Echo gate {echoGate ? "on" : "off"}</button>
              <button onClick={toggleGlasses} disabled={source === "camera"} className={`${chip} disabled:opacity-40`}>{source === "glasses" || glasses.current ? "Leave glasses" : "Use glasses"}</button>
              <button onClick={toggleCamera} disabled={source === "glasses"} className={`${chip} disabled:opacity-40`}>{source === "camera" ? "Use the recorded walk" : "Use this camera"}</button>
            </>
          )}
          <span className="flex items-center gap-2 text-[#D3D3D1]"><i className="h-2 w-2 rounded-full bg-[#FF4D3D]" />{source === "glasses" ? "Glasses" : source === "camera" ? (demo ? "Mac camera" : "Camera") : demo ? "Starting" : "Recorded walk"} · {clock(now)}</span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        {/* Left: what the glasses see */}
        <div className="relative aspect-[3/4] w-full shrink-0 overflow-hidden rounded-2xl bg-black lg:h-full lg:w-auto">
          <video ref={video} src={demo ? undefined : "/twin-local/pov.mp4"} autoPlay muted loop playsInline onClick={() => cutIn.current()} className="h-full w-full object-cover" />
          {seeing.map((o) => (
            <span key={o.label} className="pointer-events-none absolute border-[1.5px] border-[#F4F4F2] transition-all duration-200 ease-linear"
              style={{ top: `${o.box[0] / 10}%`, left: `${o.box[1] / 10}%`, height: `${(o.box[2] - o.box[0]) / 10}%`, width: `${(o.box[3] - o.box[1]) / 10}%` }}>
              <b className="absolute left-0 top-0 -translate-y-full whitespace-nowrap bg-[#F4F4F2] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-[#0B0B0C]">{o.label === "item" && named ? named.query : o.label}</b>
            </span>
          ))}
          <p className="absolute left-3 top-3 rounded-full border border-white/15 bg-black/60 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] backdrop-blur-md">Glasses POV · Live</p>
          <div className="absolute inset-x-3 bottom-3 flex flex-col gap-1.5">
            {(hearing || lastSaid) && <p className="w-fit max-w-[88%] rounded-2xl border border-white/15 bg-black/65 px-3.5 py-2.5 backdrop-blur-md"><b className="mr-2 text-[11px] tracking-[0.1em] text-[#B9B9B5]">YOU</b>{lastSaid || <span className="text-[#B9B9B5]">listening…</span>}</p>}
            {reply && <p data-reply className="w-fit max-w-[88%] self-end rounded-2xl bg-[#F4F4F2] px-3.5 py-2.5 font-medium text-[#0B0B0C]"><b className="mr-2 text-[11px] tracking-[0.1em] text-[#55554F]">BEARLY</b>{reply}</p>}
          </div>
        </div>

        {/* Middle: seen stream */}
        <div className={`flex w-full shrink-0 flex-col gap-3 ${spatial ? "lg:w-[400px]" : "lg:w-[236px]"}`}>
        {spatial && (
          <div data-room className="relative h-[300px] shrink-0 overflow-hidden rounded-2xl border border-[#2A2A2E] lg:h-[46%]">
            <PinRoom pins={pins} here={camera ? null : here} trail={camera ? [] : trail} recon={camera ? null : recon} time={now} track={livePos ?? (demo ? IDLE_TRACK : null)} space={camera ? space : null} cal={cal} />
            {camera && space && (
              <div className="absolute bottom-2 right-2 flex gap-1 text-xs">
                {([["⟲", (c: Cal) => ({ ...c, yaw: c.yaw + Math.PI / 12 })], ["⟳", (c: Cal) => ({ ...c, yaw: c.yaw - Math.PI / 12 })], ["−", (c: Cal) => ({ ...c, scale: c.scale / 1.1 })], ["+", (c: Cal) => ({ ...c, scale: c.scale * 1.1 })], ["←", (c: Cal) => ({ ...c, x: c.x - 0.5 })], ["→", (c: Cal) => ({ ...c, x: c.x + 0.5 })], ["↑", (c: Cal) => ({ ...c, z: c.z - 0.5 })], ["↓", (c: Cal) => ({ ...c, z: c.z + 0.5 })]] as [string, (c: Cal) => Cal][]).map(([label, f]) => (
                  <button key={label} onClick={() => nudge(f)} title="Line the rebuilt room up with the live tracking" className="h-6 w-6 rounded border border-[#3A3A3F] bg-black/50 text-[#B9B9B5]">{label}</button>
                ))}
              </div>
            )}
            <p className="pointer-events-none absolute left-3 top-3 text-[11px] font-bold uppercase tracking-[0.14em] text-[#8C8C88]">{livePos ? `Live · where you are` : camera && space ? "This room · rebuilt from a phone video" : camera ? "Captured, in order" : recon ? "Where · rebuilt from the glasses video" : "Where · schematic, not measured"}</p>
            <p className="pointer-events-none absolute bottom-3 left-3 text-xs text-[#8C8C88]">{pins.length} pinned</p>
          </div>
        )}
        {spatial && livePos && (() => {
          // Steps and body direction come from the phone in the pocket, head turn from the glasses. Distance is the length of the drawn path.
          const walked = livePos.path.reduce((sum, pt, n) => (n ? sum + Math.hypot(pt[0] - livePos.path[n - 1][0], pt[1] - livePos.path[n - 1][1]) : 0), 0)
          const deg = (r: number) => Math.round((((r * 180) / Math.PI) % 360 + 360) % 360)
          const turn = Math.round((livePos.head.yaw * 180) / Math.PI)
          return (
            <div data-stats className="grid shrink-0 grid-cols-4 rounded-2xl border border-[#2A2A2E] px-4 py-3">
              {([["Steps", String(livePos.steps)], ["Walked", `${walked.toFixed(1)} m`], ["Body", `${deg(livePos.heading)}°`], ["Head", `${turn > 0 ? "+" : ""}${turn}°`]] as const).map(([label, value]) => (
                <div key={label}><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#8C8C88]">{label}</p><p className="text-xl font-bold tabular-nums">{value}</p></div>
              ))}
            </div>
          )
        })()}
        <div className="flex max-h-60 min-h-0 w-full flex-1 flex-col rounded-2xl border border-[#2A2A2E] p-4 lg:max-h-none">
          <div className="flex items-baseline justify-between pb-2.5"><b className="text-[11px] uppercase tracking-[0.14em] text-[#8C8C88]">Seen · Jev, live</b><span className="text-xs text-[#8C8C88]">{seenLog.length}</span></div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {seenLog.map((r, i) => (
              <div key={r.key} className="flex items-center gap-2.5 py-[7px]" style={{ opacity: Math.max(0.3, 1 - i * 0.09) }}>
                <span className="w-9 shrink-0 text-xs tabular-nums text-[#8C8C88]">{clock(r.t)}</span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {r.thumb ? <img src={r.thumb} alt="" className="h-[30px] w-[30px] shrink-0 rounded-md object-cover" /> : <span className="h-[30px] w-[30px] shrink-0 rounded-md border border-[#3A3A3F]" />}
                <span className="min-w-0 flex-1 truncate text-sm">{r.label}</span>
                {seeing.some((o) => o.label === r.label) && seenLog.findIndex((x) => x.label === r.label) === i && <span className="shrink-0 text-[11px] text-[#9CB4FF]">in view now</span>}
              </div>
            ))}
          </div>
        </div>

        </div>

        {/* Right: what you asked for */}
        <div className="flex min-h-[420px] min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-baseline justify-between"><b className="text-[11px] uppercase tracking-[0.14em] text-[#8C8C88]">You asked · {asks.length}</b><span className="text-xs tabular-nums text-[#D3D3D1]">Bought so far {usd(total)}</span></div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            {asks.length === 0 && <p className="rounded-2xl border border-dashed border-[#2A2A2E] p-8 text-center text-sm text-[#77777A]">Look at something and say what you want. Try “Find me the cheapest one of these”.</p>}
            {asks.map((a, i) => {
              const offer = a.offers[a.pick]
              const live = a.status === "working" || a.status === "ready" || a.status === "paying"
              const collapsed = !live || (a.kind === "email" && i > 0)
              if (collapsed) return (
                <div key={a.id} data-ask={a.status} className="flex items-center gap-3 rounded-2xl border border-[#2A2A2E] px-5 py-3.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {a.thumb && <img src={a.thumb} alt="" className="h-9 w-9 shrink-0 rounded-md object-cover" />}
                  <div className="min-w-0 flex-1"><p className="text-xs text-[#77777A]">{clock(a.t)}</p><p className="truncate text-[15px] text-[#D3D3D1]">“{a.said}”</p></div>
                  {a.paid ? <b className="whitespace-nowrap text-[13px] tracking-[0.06em] text-[#FFD100]">✓ BOUGHT · {usd(a.paid.amount)}</b>
                    : <b className="whitespace-nowrap text-[11px] tracking-[0.1em] text-[#8C8C88]">{a.reading ? `${a.reading.value} ${a.reading.unit}`.trim() : a.kind === "note" ? "✓ IN REPORT" : a.status.toUpperCase()}</b>}
                </div>
              )
              return (
                <article key={a.id} data-ask={a.status} className="flex flex-col gap-3.5 rounded-2xl border border-[#3A3A3F] bg-[#141416] p-5">
                  <div className="flex items-start gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {a.thumb && a.kind !== "email" && <img src={a.thumb} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />}
                    <div><p className="text-xs text-[#8C8C88]">{clock(a.t)}</p><p className="line-clamp-2 text-xl font-semibold leading-[26px]">“{a.said}”</p></div>
                  </div>
                  <ol className="flex flex-col gap-2 border-l border-[#2A2A2E] pl-3.5">
                    {a.steps.map((s, k) => (
                      <li key={k} className="flex items-baseline justify-between gap-3">
                        <span className={`text-sm leading-5 ${s.state === "fail" ? "text-[#F4F4F2]" : "text-[#B9B9B5]"}`}>{s.state === "run" ? <i className="mr-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#F4F4F2] align-middle" /> : s.state === "done" ? "✓ " : "✕ "}<Typed text={s.text} /></span>
                        {s.tag && <b className="whitespace-nowrap text-[10px] tracking-[0.1em] text-[#77777A]">{s.tag}</b>}
                      </li>
                    ))}
                    
                  </ol>

                  {a.kind === "find" && offer && (
                    <div className="vb-in flex flex-col gap-3 rounded-xl bg-[#1C1C1F] p-[18px]">
                      <b className="text-[11px] uppercase tracking-[0.14em] text-[#B9B9B5]">{a.pick === 0 ? "Cheapest" : `Best match · ${a.pick + 1}/${a.offers.length}`}</b>
                      <div className="flex items-center gap-4">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {offer.image && <img src={offer.image} alt="" className="h-20 w-20 shrink-0 rounded-lg bg-white object-contain" />}
                        <div className="min-w-0 flex-1"><p className="line-clamp-2 text-[17px] font-semibold leading-[23px]">{offer.title}</p><p className="text-[13px] text-[#8C8C88]">{offer.seller}</p></div>
                        <b data-price className="whitespace-nowrap text-[34px] tracking-tight text-[#FFD100]">{usd(offer.priceCents)}</b>
                      </div>
                      <div className="flex gap-2 overflow-x-auto">
                        {a.offers.map((o, k) => (
                          <button key={k} onClick={() => patch(a.id, (x) => ({ ...x, pick: k }))} style={{ animationDelay: `${150 + k * 90}ms` }} className={`vb-in flex w-[92px] shrink-0 flex-col gap-1 rounded-lg border p-1.5 text-left ${k === a.pick ? "border-[#F4F4F2]" : "border-[#2A2A2E]"}`}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            {o.image ? <img src={o.image} alt="" className="h-16 w-full rounded bg-white object-contain" /> : <span className="h-16 w-full rounded bg-[#2A2A2E]" />}
                            <span className="text-xs tabular-nums">{usd(o.priceCents)}</span>
                          </button>
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => send("Buy it")} disabled={a.status !== "ready"} className="whitespace-nowrap rounded-full bg-[#F4F4F2] px-3.5 py-2 text-sm font-semibold text-[#0B0B0C] disabled:opacity-40">“buy it”</button>
                        <button onClick={() => send("Skip")} className={chip}>“skip”</button>
                        <button onClick={() => send("Show me the next one")} className={chip}>“next”</button>
                      </div>
                    </div>
                  )}

                  {a.kind === "email" && a.status === "ready" && (
                    <div className="vb-in flex flex-col gap-3 rounded-xl bg-[#1C1C1F] p-[18px]">
                      <b className="text-[11px] uppercase tracking-[0.14em] text-[#B9B9B5]">For your manager · draft</b>
                      <p className="text-[17px] font-semibold leading-[23px]">{paidAsks.length} bought · {usd(total)}</p>
                      <div className="flex gap-3">
                        <button onClick={() => setZoom("invoice")} className="w-[190px] text-left"><Invoice /><p className="mt-2 text-[13px] font-semibold">Invoice.pdf</p></button>
                        <button onClick={() => setZoom("report")} className="w-[190px] text-left"><Report /><p className="mt-2 text-[13px] font-semibold">Walk report.pdf</p></button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => send("Show me the invoice")} className="whitespace-nowrap rounded-full bg-[#F4F4F2] px-3.5 py-2 text-sm font-semibold text-[#0B0B0C]">“show invoice”</button>
                        <button onClick={() => send("Show me the report")} className={chip}>“show report”</button>
                      </div>
                    </div>
                  )}
                </article>
              )
            })}
          </div>

          <form onSubmit={(e) => { e.preventDefault(); send(text) }} className="flex flex-col gap-2">
            <div className="flex gap-2 overflow-x-auto">{QUICK.map((q) => <button type="button" key={q} onClick={() => send(q)} className={`${chip} !py-1.5 !text-xs`}>{q}</button>)}</div>
            <div className="flex gap-2">
              <button type="button" onClick={() => void toggleLive()} className={`whitespace-nowrap rounded-full px-4 py-2.5 text-sm font-semibold ${liveState === "on" ? "bg-[#F4F4F2] text-[#0B0B0C]" : "border border-[#3A3A3F]"}`}>{liveState === "on" ? "Live · on" : liveState === "connecting" ? "Connecting…" : "Talk live"}</button>
              <button type="button" onClick={() => setPtt((x) => !x)} onPointerDown={() => { if (ptt) { cutIn.current(); held.current = true } }} onPointerUp={() => { held.current = false }} onPointerLeave={() => { held.current = false }}
                title="For loud rooms: the assistant only listens while Space is held" className={`whitespace-nowrap rounded-full px-4 py-2.5 text-sm font-semibold ${ptt ? "bg-[#F4F4F2] text-[#0B0B0C]" : "border border-[#3A3A3F]"}`}>{ptt ? "Hold Space to talk · on" : "Hold to talk"}</button>
              <button type="button" onClick={toggleMic} disabled={liveState !== "off"} className={`whitespace-nowrap rounded-full px-4 py-2.5 text-sm font-semibold ${listening ? "bg-[#F4F4F2] text-[#0B0B0C]" : "border border-[#3A3A3F]"}`}>{listening ? "Listening…" : "Mic (old)"}</button>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Or type what you would say" className="min-w-0 flex-1 rounded-full border border-[#3A3A3F] bg-transparent px-4 py-2.5 text-sm outline-none placeholder:text-[#55555A]" />
              <button type="submit" className="whitespace-nowrap rounded-full border border-[#3A3A3F] px-4 py-2.5 text-sm">Say</button>
            </div>
            <p data-mic className="px-1 text-[11px] text-[#77777A]">Mic: {mic}{liveState === "on" && micLevel ? ` · ${micLevel}` : ""}</p>
          </form>
        </div>
      </div>

      {zoom === "board" && (
        <div data-zoom="board" className="fixed inset-0 z-50 flex flex-col gap-5 overflow-y-auto bg-[#0B0B0C]/95 p-6 backdrop-blur-md lg:p-10">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#B9B9B5]">Bearly · This session on one board</p>
              <h2 className="text-3xl font-black tracking-tight">{new Set(seenLog.map((r) => r.label)).size} things seen · {asks.filter((a) => a.kind !== "email").length} asked · <span className={paidAsks.length ? "text-[#FFD100]" : ""}>{paidAsks.length} bought, {usd(total)}</span></h2>
            </div>
            <button onClick={() => setZoom(null)} className={chip}>Close</button>
          </div>
          {asks.filter((a) => a.kind !== "email").length > 0 && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {[...asks].reverse().filter((a) => a.kind !== "email").map((a, k) => {
                const o = a.offers[a.pick]
                return (
                  <div key={a.id} style={{ animationDelay: `${k * 70}ms` }} className={`vb-in flex gap-3 rounded-2xl border p-4 ${a.paid ? "border-[#F4F4F2]" : "border-[#2A2A2E]"} bg-[#141416]`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {a.thumb ? <img src={a.thumb} alt="" className="h-24 w-24 shrink-0 rounded-xl object-cover" /> : <span className="h-24 w-24 shrink-0 rounded-xl border border-[#2A2A2E]" />}
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <p className="text-xs text-[#77777A]">{clock(a.t)} · {a.kind === "note" ? "note" : "you asked"}</p>
                      <p className="line-clamp-2 text-[15px] leading-5">“{a.said}”</p>
                      {o && (
                        <div className="mt-auto flex items-center gap-2">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          {o.image && <img src={o.image} alt="" className="h-9 w-9 shrink-0 rounded bg-white object-contain" />}
                          <p className="min-w-0 flex-1 truncate text-xs text-[#B9B9B5]">{o.title} · {o.seller}</p>
                          <b className={`whitespace-nowrap text-sm ${a.paid ? "text-[#FFD100]" : ""}`}>{a.paid ? "✓ " : ""}{usd(o.priceCents)}</b>
                        </div>
                      )}
                      {!o && <b className="mt-auto text-[11px] tracking-[0.1em] text-[#8C8C88]">{a.kind === "note" ? "✓ IN REPORT" : a.status.toUpperCase()}</b>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {annotate && asks.some((a) => a.shot) && (
            <>
              <b className="text-[11px] uppercase tracking-[0.14em] text-[#8C8C88]">Annotated photos · nothing written down</b>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {[...asks].reverse().filter((a) => a.shot).map((a, k) => {
                  const o = a.offers[a.pick]
                  const tag = a.reading ? `${a.reading.what}: ${a.reading.value} ${a.reading.unit}`.trim() : a.paid ? `Bought · ${usd(a.paid.amount)}` : o ? `${usd(o.priceCents)} · ${o.seller}` : "Note"
                  const b = a.box
                  return (
                    <figure key={a.id} data-shot style={{ animationDelay: `${k * 80}ms` }} className="vb-in flex shrink-0 flex-col gap-2">
                      <div className="relative overflow-hidden rounded-xl bg-black">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={a.shot!} alt="" className="block w-full" />
                        {b && <span className="absolute border-2 border-[#F4F4F2]" style={{ top: `${b[0] / 10}%`, left: `${b[1] / 10}%`, height: `${(b[2] - b[0]) / 10}%`, width: `${(b[3] - b[1]) / 10}%` }} />}
                        <span className="absolute max-w-[90%] truncate rounded-md bg-[#F4F4F2] px-2 py-1 text-xs font-bold text-[#0B0B0C]"
                          style={b ? { top: `${Math.max(2, b[0] / 10 - 7)}%`, left: `${Math.min(60, b[1] / 10)}%` } : { top: "4%", left: "4%" }}>{k + 1} · {tag}</span>
                      </div>
                      <figcaption className="text-xs text-[#B9B9B5]"><span className="tabular-nums text-[#77777A]">{clock(a.t)}</span> “{a.said}”</figcaption>
                    </figure>
                  )
                })}
              </div>
              {asks.some((a) => a.zone) && (
                <>
                  <b className="text-[11px] uppercase tracking-[0.14em] text-[#8C8C88]">Where · schematic of the recorded walk, not measured</b>
                  <svg data-plan viewBox="-9 -5.6 18.4 11.2" style={{ aspectRatio: "18.4 / 11.2" }} className="w-full max-w-3xl shrink-0 rounded-xl border border-[#2A2A2E] bg-[#141416]">
                    <rect x="-8.4" y="-5" width="7.4" height="10" rx="0.2" fill="none" stroke="#3A3A3F" strokeWidth="0.06" />
                    <rect x="-0.2" y="-5" width="8.6" height="10" rx="0.2" fill="none" stroke="#3A3A3F" strokeWidth="0.06" />
                    {ZONES.map((z) => (
                      <g key={z.id}>
                        <circle cx={z.stand[0]} cy={z.stand[1]} r="0.09" fill="#55555A" />
                        <text x={z.stand[0]} y={z.stand[1] + 0.5} fontSize="0.32" fill="#77777A" textAnchor="middle">{z.name}</text>
                      </g>
                    ))}
                    {[...asks].reverse().filter((a) => a.shot).map((a, k) => {
                      const z = ZONES.find((x) => x.id === a.zone)
                      return z && (
                        <g key={a.id}>
                          <circle cx={z.stand[0]} cy={z.stand[1]} r="0.42" fill={a.paid ? "#FFD100" : "#F4F4F2"} />
                          <text x={z.stand[0]} y={z.stand[1] + 0.15} fontSize="0.44" fontWeight="700" fill="#0B0B0C" textAnchor="middle">{k + 1}</text>
                        </g>
                      )
                    })}
                  </svg>
                </>
              )}
            </>
          )}
          <b className="text-[11px] uppercase tracking-[0.14em] text-[#8C8C88]">Everything seen</b>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-8 xl:grid-cols-10">
            {(() => {
              // One tile per distinct thing: the latest picture of it, when it was first seen, and how many times.
              const groups = new Map<string, { label: string; thumb: string | null; first: number; n: number; key: number }>()
              for (const r of [...seenLog].reverse()) {
                const g = groups.get(r.label)
                if (g) { g.n++; if (r.thumb) g.thumb = r.thumb } else groups.set(r.label, { label: r.label, thumb: r.thumb, first: r.t, n: 1, key: r.key })
              }
              return [...groups.values()].map((g, k) => (
                <div key={g.key} data-seen-tile style={{ animationDelay: `${Math.min(k, 60) * 35}ms` }} className="vb-in flex flex-col gap-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {g.thumb ? <img src={g.thumb} alt="" className="aspect-square w-full rounded-lg object-cover" /> : <span className="aspect-square w-full rounded-lg border border-[#2A2A2E]" />}
                  <p className="truncate text-xs">{g.label}</p>
                  <p className="text-[10px] tabular-nums text-[#77777A]">{clock(g.first)}{g.n > 1 ? ` · seen ${g.n} times` : ""}</p>
                </div>
              ))
            })()}
            {seenLog.length === 0 && <p className="col-span-full text-sm text-[#77777A]">Nothing seen yet.</p>}
          </div>
        </div>
      )}
      {zoom && zoom !== "board" && (
        <div data-zoom={zoom} onClick={() => setZoom(null)} className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm">
          <div onClick={(e) => e.stopPropagation()} className="max-h-full w-full max-w-2xl overflow-y-auto">
            {zoom === "invoice" ? <Invoice big /> : <Report big />}
            <button onClick={() => setZoom(null)} className={`${chip} mt-3`}>Close</button>
          </div>
        </div>
      )}
    </main>
  )
}

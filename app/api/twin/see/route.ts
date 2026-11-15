import { HINTS, ZONES } from "@/components/twin/world"

// Twin demo: recognise where the wearer is from one glasses frame, and box the equipment in view.
// One request to Jev (TypeSafe System One) per frame: a Choice for the zone, plus a Noul (is it there?)
// and a Box (where?) for each equipment type. A Box always returns four edges, so the Noul gates it.

export const maxDuration = 15

const THINGS: Record<string, string> = {
  pump: "pump or pump motor", tank: "tank or vessel", "control panel": "control cabinet or control panel", "touch screen": "touch screen display",
  valve: "valve handle", gauge: "round pressure gauge", "filter housing": "tall filter housing", "chemical jug": "blue chemical jug", door: "door", hand: "the wearer's hand or arm",
}
// Things people wear or carry, for the buying demo (mode "wear"). No zone question in this mode.
const WEAR: Record<string, string> = {
  item: "product or object that a person is holding up in their hand toward the camera",
  jacket: "jacket, hoodie or sweater worn by a person", shirt: "shirt or t-shirt worn by a person", hat: "hat or cap", glasses: "pair of glasses or sunglasses",
  shoes: "shoe or pair of shoes", bag: "bag or backpack", logo: "brand logo or printed brand name", laptop: "laptop computer", phone: "mobile phone",
  bottle: "water bottle or drink can", cup: "cup or mug", headphones: "headphones or earbuds", watch: "wrist watch",
}
function build(things: Record<string, string>, zone: boolean): Record<string, unknown> {
  const q: Record<string, unknown> = zone
    ? { zone: { type: "choice", instructions: "Where is the person wearing the camera standing, judging by what `photo` shows?", criteria: Object.fromEntries(ZONES.map((z) => [z.id, HINTS[z.id] ?? z.name])) } }
    : {}
  for (const [k, d] of Object.entries(things)) {
    q["has:" + k] = { type: "noul", instructions: `Is a ${d} clearly visible in \`photo\`?` }
    q["box:" + k] = { type: "box", instructions: `the most prominent ${d} in \`photo\`` }
  }
  return q
}
const QUESTIONS = build(THINGS, true)
const WEAR_QUESTIONS = build(WEAR, false)

type Answers = Record<string, { choice?: string; confidence?: number; noul?: number; box?: { top: number; left: number; bottom: number; right: number } }>

export async function POST(req: Request) {
  const started = Date.now()
  try {
    const { frame, mode, track } = (await req.json()) as { frame?: string; mode?: string; track?: string }
    // `track` is a product name another model already read; Jev follows that exact thing from frame to frame.
    const name = typeof track === "string" ? track.replace(/[`"\n]/g, " ").trim().slice(0, 80) : ""
    const things = mode === "wear" ? (name ? { ...WEAR, [name]: name } : WEAR) : THINGS
    if (!frame) return Response.json({ error: "frame is required" }, { status: 400 })
    const key = process.env.JEV_API_KEY
    if (!key) return Response.json({ error: "JEV_API_KEY is not set" }, { status: 500 })
    const r = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST", signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "TypeSafe-Danger-Zone-Images": "true" },
      body: JSON.stringify({
        model: process.env.JEV_MODEL || "jev-latest",
        state: { photo: "frame-7c1e-asset" },
        assets: { "frame-7c1e-asset": { type: "image", data_base64: frame.replace(/^data:image\/\w+;base64,/, ""), format: "jpg" } },
        questions: mode === "wear" ? (name ? build(things, false) : WEAR_QUESTIONS) : QUESTIONS,
      }),
    })
    if (!r.ok) return Response.json({ error: `Jev ${r.status}`, ms: Date.now() - started }, { status: 502 })
    const a = ((await r.json()) as { answers: Answers }).answers
    const objects = Object.keys(things)
      .filter((k) => (a["has:" + k]?.noul ?? 0) > (k === name ? 0.4 : 0.6) && (a["box:" + k]?.confidence ?? 0) > (k === name ? 0.25 : 0.4) && a["box:" + k]?.box)
      .map((k) => { const b = a["box:" + k].box!; return { label: k, box: [b.top, b.left, b.bottom, b.right].map((v) => Math.round(v * 1000)) } })
    const zone = (a.zone?.confidence ?? 0) > 0.45 ? a.zone?.choice ?? null : null
    return Response.json({ zone, objects, ms: Date.now() - started })
  } catch (error) {
    console.error("Twin see error:", error)
    return Response.json({ error: error instanceof Error ? error.message : "Recognition failed", ms: Date.now() - started }, { status: 500 })
  }
}

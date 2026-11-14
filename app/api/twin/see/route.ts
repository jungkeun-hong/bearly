// Recognise what the wearer is holding or wearing in one glasses frame, with Jev (TypeSafe System One).
// One request per frame: a Noul (is it there?) and a Box (where?) for each kind of thing. A Box always returns four
// edges, so the Noul gates it. `track` is a product name Gemini already read; Jev then follows that exact thing.

export const maxDuration = 15

const WEAR: Record<string, string> = {
  item: "product or object that a person is holding up in their hand toward the camera",
  jacket: "jacket, hoodie or sweater worn by a person", shirt: "shirt or t-shirt worn by a person", hat: "hat or cap", glasses: "pair of glasses or sunglasses",
  shoes: "shoe or pair of shoes", bag: "bag or backpack", logo: "brand logo or printed brand name", laptop: "laptop computer", phone: "mobile phone",
  bottle: "water bottle or drink can", cup: "cup or mug", headphones: "headphones or earbuds", watch: "wrist watch",
}

function build(things: Record<string, string>): Record<string, unknown> {
  const q: Record<string, unknown> = {}
  for (const [k, d] of Object.entries(things)) {
    q["has:" + k] = { type: "noul", instructions: `Is a ${d} clearly visible in \`photo\`?` }
    q["box:" + k] = { type: "box", instructions: `the most prominent ${d} in \`photo\`` }
  }
  return q
}

type Answers = Record<string, { noul?: number; confidence?: number; box?: { top: number; left: number; bottom: number; right: number } }>

export async function POST(req: Request) {
  const started = Date.now()
  try {
    const { frame, track } = (await req.json()) as { frame?: string; track?: string }
    if (!frame) return Response.json({ error: "frame is required" }, { status: 400 })
    const key = process.env.JEV_API_KEY
    if (!key) return Response.json({ error: "JEV_API_KEY is not set" }, { status: 500 })
    const name = typeof track === "string" ? track.replace(/[`"\n]/g, " ").trim().slice(0, 80) : ""
    const things = name ? { ...WEAR, [name]: name } : WEAR
    const r = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST", signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "TypeSafe-Danger-Zone-Images": "true" },
      body: JSON.stringify({
        model: process.env.JEV_MODEL || "jev-latest",
        state: { photo: "frame-7c1e-asset" },
        assets: { "frame-7c1e-asset": { type: "image", data_base64: frame.replace(/^data:image\/\w+;base64,/, ""), format: "jpg" } },
        questions: build(things),
      }),
    })
    if (!r.ok) return Response.json({ error: `Jev ${r.status}`, ms: Date.now() - started }, { status: 502 })
    const a = ((await r.json()) as { answers: Answers }).answers
    const objects = Object.keys(things)
      .filter((k) => (a["has:" + k]?.noul ?? 0) > (k === name ? 0.4 : 0.6) && (a["box:" + k]?.confidence ?? 0) > (k === name ? 0.25 : 0.4) && a["box:" + k]?.box)
      .map((k) => { const b = a["box:" + k].box!; return { label: k, box: [b.top, b.left, b.bottom, b.right].map((v) => Math.round(v * 1000)) } })
    return Response.json({ zone: null, objects, ms: Date.now() - started })
  } catch (error) {
    console.error("see error:", error)
    return Response.json({ error: error instanceof Error ? error.message : "Recognition failed", ms: Date.now() - started }, { status: 500 })
  }
}

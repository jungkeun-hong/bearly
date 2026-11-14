// Bearly: estimated depth for one captured frame, from the local depth service (scripts/vb-depth.py).
// Returns a small grey PNG as a data URL (white = near). If the service is not running, says so; the page then shows flat cards.

export const maxDuration = 15

export async function POST(req: Request) {
  const started = Date.now()
  try {
    const { frame } = (await req.json()) as { frame?: string }
    if (!frame) return Response.json({ error: "frame is required" }, { status: 400 })
    const r = await fetch(process.env.VB_DEPTH_URL || "http://127.0.0.1:3128/depth", {
      method: "POST", signal: AbortSignal.timeout(10000), headers: { "Content-Type": "image/jpeg" },
      body: Buffer.from(frame.replace(/^data:image\/\w+;base64,/, ""), "base64"),
    })
    if (!r.ok) return Response.json({ error: `depth service ${r.status}`, ms: Date.now() - started }, { status: 502 })
    const png = Buffer.from(await r.arrayBuffer()).toString("base64")
    return Response.json({ depth: `data:image/png;base64,${png}`, modelMs: Number(r.headers.get("X-Ms")) || null, ms: Date.now() - started })
  } catch {
    return Response.json({ error: "The depth service is not running", ms: Date.now() - started }, { status: 503 })
  }
}

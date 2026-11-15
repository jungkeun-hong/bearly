// Bearly: one assistant at a time, across every browser and window that has the stage open.
// A page running the live assistant checks in here every 2 s. Another page that tries to start one while a fresh
// check-in exists is told the assistant is busy, and a page that is no longer the owner closes its own session.
// Held in this server's memory only, which is enough for one stage Mac.

type Owner = { id: string; at: number }
const g = globalThis as unknown as { __bearlyLive?: Owner }
const FRESH_MS = 5000

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? ""
  const o = g.__bearlyLive
  const alive = !!o && Date.now() - o.at < FRESH_MS
  if (o && o.id === id) o.at = Date.now() // a check-in from the owner keeps it fresh
  return Response.json({ mine: !!o && o.id === id, busy: alive && o!.id !== id })
}

/** Claim the assistant for this page. `force` (a click on Talk live) takes it over from a page that holds it. */
export async function POST(req: Request) {
  const { id, force } = (await req.json()) as { id?: string; force?: boolean }
  if (!id) return Response.json({ error: "id is required" }, { status: 400 })
  const o = g.__bearlyLive
  if (o && o.id !== id && Date.now() - o.at < FRESH_MS && !force) return Response.json({ ok: false, busy: true })
  g.__bearlyLive = { id, at: Date.now() }
  return Response.json({ ok: true })
}

/** Release when the page closes its session. */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? ""
  if (g.__bearlyLive?.id === id) g.__bearlyLive = undefined
  return Response.json({ ok: true })
}

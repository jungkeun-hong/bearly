// Bearly: the phone app sends its status lines here so they show up in the stage server's log.

export async function POST(req: Request) {
  try {
    const { from, text, frames } = (await req.json()) as { from?: string; text?: string; frames?: number }
    console.log(`[vb:${String(from ?? "?").slice(0, 12)}] ${String(text ?? "").slice(0, 300)}${typeof frames === "number" ? ` · ${frames} frames` : ""}`)
  } catch { /* a log line that cannot be read is dropped */ }
  return Response.json({ ok: true })
}

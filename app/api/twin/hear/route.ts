// Bearly: turn one spoken sentence (a short audio clip from the page's microphone) into text.
// The page does not depend on the browser's own speech recognition. Tries each speech service that has a key,
// in order: ElevenLabs, OpenAI, Gemini. The answer says which one wrote the text.

export const maxDuration = 25

type Heard = { text: string } | { error: string }

async function elevenlabs(audio: Blob, key: string): Promise<Heard> {
  const form = new FormData()
  form.append("model_id", "scribe_v1"); form.append("language_code", "en"); form.append("tag_audio_events", "false")
  form.append("file", audio, "say.webm")
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", signal: AbortSignal.timeout(12000), headers: { "xi-api-key": key }, body: form })
  const j = await r.json()
  return r.ok ? { text: String(j.text ?? "") } : { error: `ElevenLabs: ${j?.detail?.message ?? r.status}` }
}

async function openai(audio: Blob, key: string): Promise<Heard> {
  const form = new FormData()
  form.append("model", "gpt-4o-mini-transcribe"); form.append("language", "en")
  form.append("prompt", "The speaker talks in English to a shopping assistant. Typical sentences: Find me the cheapest one of these. What is this? Show me the next one. Buy it. Buy it, then email my manager the invoice and the report. Show me the invoice.")
  form.append("file", audio, audio.type.includes("aiff") ? "say.aiff" : audio.type.includes("mp4") ? "say.mp4" : "say.webm")
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${key}` }, body: form })
  const j = await r.json()
  return r.ok ? { text: String(j.text ?? "") } : { error: `OpenAI: ${j?.error?.message ?? r.status}` }
}

async function gemini(audio: Blob, key: string): Promise<Heard> {
  const data = Buffer.from(await audio.arrayBuffer()).toString("base64")
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
    method: "POST", signal: AbortSignal.timeout(12000), headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: "Write down exactly the English words spoken in this clip. Only the words. If nobody speaks, answer with nothing." }, { inline_data: { mime_type: audio.type.split(";")[0] || "audio/webm", data } }] }],
      generationConfig: { temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
    }),
  })
  const j = await r.json()
  return r.ok ? { text: (j.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("") } : { error: `Gemini: ${j?.error?.message ?? r.status}` }
}

export async function POST(req: Request) {
  const started = Date.now()
  try {
    const audio = await req.blob()
    if (audio.size < 2000) return Response.json({ text: "", ms: Date.now() - started })
    if (audio.size > 4_000_000) return Response.json({ error: "The clip is too long" }, { status: 413 })
    const services: [string, string | undefined, (a: Blob, k: string) => Promise<Heard>][] = [
      ["elevenlabs", process.env.ELEVENLABS_API_KEY, elevenlabs], ["openai", process.env.OPENAI_API_KEY, openai], ["gemini", process.env.GEMINI_API_KEY, gemini],
    ]
    const errors: string[] = []
    for (const [via, key, run] of services) {
      if (!key) continue
      try {
        const h = await run(audio, key)
        if ("error" in h) { errors.push(h.error); continue }
        const text = h.text.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim()
        console.log(`[vb] heard (${via}, ${Math.round(audio.size / 1000)} kB, ${Date.now() - started} ms): ${text ? JSON.stringify(text) : "no words"}`)
        return Response.json({ text, via, skipped: errors, ms: Date.now() - started })
      } catch (e) { errors.push(`${via}: ${e instanceof Error ? e.message : "failed"}`) }
    }
    return Response.json({ error: errors.join(" | ") || "No speech service key is set", ms: Date.now() - started }, { status: 502 })
  } catch (error) {
    console.error("Twin hear error:", error)
    return Response.json({ error: error instanceof Error ? error.message : "Could not hear that", ms: Date.now() - started }, { status: 502 })
  }
}

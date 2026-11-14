// Bearly: say the assistant's reply out loud with ElevenLabs text to speech.
// GET so the page can point an <audio> at it and start playing while the sound is still arriving.

export const maxDuration = 15

export async function GET(req: Request) {
  const key = process.env.ELEVENLABS_API_KEY
  const text = new URL(req.url).searchParams.get("text")
  if (!key || !text) return Response.json({ error: "ELEVENLABS_API_KEY and text are required" }, { status: 400 })
  const voice = new URL(req.url).searchParams.get("voice") || process.env.ELEVENLABS_VOICE_ID || "UgBBYS2sOqTuMpoF3BR0" // Mark, Natural Conversations
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=mp3_44100_64&optimize_streaming_latency=3`, {
    method: "POST", signal: AbortSignal.timeout(12000),
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 300), model_id: "eleven_flash_v2_5", voice_settings: { speed: 1.12, stability: 0.4, similarity_boost: 0.8 } }),
  })
  if (!r.ok || !r.body) return Response.json({ error: `ElevenLabs ${r.status}: ${(await r.text()).slice(0, 200)}` }, { status: 502 })
  return new Response(r.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } })
}

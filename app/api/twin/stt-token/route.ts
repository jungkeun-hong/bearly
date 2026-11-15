// Bearly: a 60-second Deepgram token for the on-screen subtitles of what the wearer says.
// Gemini Live's own transcript cannot be pinned to English and sometimes shows Spanish or Japanese for accented English.
// Deepgram with language=en is used only for the words shown on screen; Gemini still hears the audio itself.
// Token-based auth as documented: POST /v1/auth/grant with the key, the browser connects with the short-lived JWT.

export async function GET() {
  const key = process.env.DEEPGRAM_API_KEY
  if (!key) return Response.json({ error: "DEEPGRAM_API_KEY is not set" }, { status: 500 })
  try {
    const r = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST", signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl_seconds: 60 }),
    })
    const d = await r.json()
    if (!r.ok || !d.access_token) return Response.json({ error: d.err_msg ?? `Deepgram ${r.status}` }, { status: 502 })
    return Response.json({ token: d.access_token })
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "token failed" }, { status: 502 })
  }
}

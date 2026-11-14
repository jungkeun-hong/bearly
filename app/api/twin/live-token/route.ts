import { GoogleGenAI } from "@google/genai"

// Bearly: a short-lived token so the browser can open a Gemini Live session (voice in, voice out, video in)
// without ever seeing the real API key. One session per token, to be started within a minute, valid 30 minutes.

export const maxDuration = 10

export async function GET() {
  try {
    const key = process.env.GEMINI_API_KEY
    if (!key) return Response.json({ error: "GEMINI_API_KEY is not set" }, { status: 500 })
    const ai = new GoogleGenAI({ apiKey: key, httpOptions: { apiVersion: "v1alpha" } })
    const token = await ai.authTokens.create({
      config: { uses: 1, expireTime: new Date(Date.now() + 30 * 60_000).toISOString(), newSessionExpireTime: new Date(Date.now() + 60_000).toISOString(), httpOptions: { apiVersion: "v1alpha" } },
    })
    return Response.json({
      token: token.name,
      model: process.env.VB_LIVE_MODEL || "gemini-3.8-live",
      // Used if the first model will not connect or drops.
      fallbackModel: process.env.VB_LIVE_FALLBACK_MODEL || "gemini-3.1-flash-live-preview",
      voice: process.env.VB_LIVE_VOICE || "Leda",
    })
  } catch (error) {
    console.error("Twin live-token error:", error)
    return Response.json({ error: error instanceof Error ? error.message : "Could not create a token" }, { status: 502 })
  }
}

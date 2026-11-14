import { createHmac } from "node:crypto"

// Bearly: LiveKit tokens for one room.
// Default: view only, for the stage page, which watches and hears what the glasses app publishes.
// ?role=glasses: publish only, for the phone app that sends the glasses camera and microphone.
// Signed here with the project's API secret (HS256). Stage tokens last two hours, glasses tokens twelve.

export const maxDuration = 5

const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url")

export async function GET(req: Request) {
  const url = process.env.LIVEKIT_URL, key = process.env.LIVEKIT_API_KEY, secret = process.env.LIVEKIT_API_SECRET
  if (!url || !key || !secret) return Response.json({ error: "LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are not all set" }, { status: 500 })
  const room = (new URL(req.url).searchParams.get("room") || process.env.VB_LIVEKIT_ROOM || "bearly").replace(/[^\w-]/g, "").slice(0, 64)
  const now = Math.floor(Date.now() / 1000)
  const publisher = new URL(req.url).searchParams.get("role") === "glasses"
  const identity = publisher ? "glasses" : `stage-${now.toString(36)}`
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = b64(JSON.stringify({
    iss: key, sub: identity, nbf: now - 10, exp: now + (publisher ? 43200 : 7200),
    video: { room, roomJoin: true, canSubscribe: !publisher, canPublish: publisher, canPublishData: publisher } // data = the phone and glasses motion readings,
  }))
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")
  return Response.json({ url, room, identity, token: `${head}.${body}.${sig}` })
}

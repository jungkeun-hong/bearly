// Bearly: actually send the quote or the manager email, but only to the sender's own inbox.
// Uses a saved Google login (an OAuth token file with the Gmail send scope; its path is the GOOGLE_TOKEN_FILE env var). The recipient is not taken from the
// request: it is always the account's own address, read from Gmail. So the demo can show a real email arriving, and
// nothing can reach anyone else. The token file is read at run time and never sent to the browser.

import { readFile } from "node:fs/promises"

export const maxDuration = 20

type Line = { label: string; amount: string; note?: string }
type Body = { kind: "quote" | "manager"; title: string; lines: Line[]; total: string; footer: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

async function accessToken() {
  const t = JSON.parse(await readFile(process.env.GOOGLE_TOKEN_FILE ?? "", "utf8"))
  const r = await fetch(t.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST", signal: AbortSignal.timeout(8000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: t.client_id, client_secret: t.client_secret, refresh_token: t.refresh_token, grant_type: "refresh_token" }),
  })
  const d = await r.json()
  if (!d.access_token) throw new Error(d.error_description || d.error || "Google login refresh failed")
  return d.access_token as string
}

export async function POST(req: Request) {
  try {
    const b = (await req.json()) as Body
    if (!b?.title || !Array.isArray(b.lines) || !b.total) return Response.json({ error: "title, lines and total are required" }, { status: 400 })
    if (!process.env.GOOGLE_TOKEN_FILE) return Response.json({ error: "GOOGLE_TOKEN_FILE is not set" }, { status: 500 })
    const token = await accessToken()
    const auth = { Authorization: `Bearer ${token}` }
    const me = (await (await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: auth })).json()).emailAddress as string
    if (!me) return Response.json({ error: "could not read the account's own address" }, { status: 502 })

    const heading = b.kind === "quote" ? "Quote for customer" : "For your manager: invoice and walk report"
    const rows = b.lines.slice(0, 30).map((l) => `<tr><td style="padding:6px 0">${esc(l.label)}${l.note ? ` <span style="color:#8C8C88">(${esc(l.note)})</span>` : ""}</td><td style="padding:6px 0;text-align:right;white-space:nowrap">${esc(l.amount)}</td></tr>`).join("")
    const html = `<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;color:#0B0B0C">
<p style="font-size:12px;letter-spacing:.12em;color:#55554F;margin:0 0 4px">BEARLY · ${esc(heading.toUpperCase())}</p>
<h2 style="margin:0 0 16px">${esc(b.title)}</h2>
<table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #C9C9C5">${rows}
<tr><td style="padding:10px 0;border-top:1px solid #C9C9C5;font-weight:bold">Total</td><td style="padding:10px 0;border-top:1px solid #C9C9C5;text-align:right;font-weight:bold">${esc(b.total)}</td></tr></table>
<p style="font-size:12px;color:#8C8C88">${esc(b.footer)}</p></div>`
    const subject = `${b.kind === "quote" ? "Quote" : "Invoice and walk report"}: ${b.title}`.slice(0, 160)
    const mime = [
      `To: ${me}`, `From: ${me}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
      "MIME-Version: 1.0", 'Content-Type: text/html; charset="UTF-8"', "", html,
    ].join("\r\n")
    const raw = Buffer.from(mime).toString("base64url")
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST", signal: AbortSignal.timeout(10000), headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ raw }),
    })
    const d = await r.json()
    if (!r.ok) return Response.json({ error: d.error?.message ?? `Gmail ${r.status}` }, { status: 502 })
    return Response.json({ sent: true, id: d.id, to: "your own inbox" })
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "send failed" }, { status: 502 })
  }
}

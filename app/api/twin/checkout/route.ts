// Bearly: Stripe Checkout in test mode only.
// POST creates a Checkout Session for one item and returns its URL.
// GET ?session_id=... returns the payment status and, once paid, the invoice PDF link.
// Uses the Stripe REST API directly, so no SDK is needed. Refuses any key that is not a test key.

export const maxDuration = 15

const API = "https://api.stripe.com/v1"

function testKey(): string | null {
  const key = process.env.STRIPE_SECRET_KEY
  return key && key.startsWith("sk_test_") ? key : null
}

async function stripe(key: string, path: string, body?: Record<string, string>) {
  const r = await fetch(API + path, {
    method: body ? "POST" : "GET",
    signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: body ? new URLSearchParams(body).toString() : undefined,
  })
  const json = await r.json()
  if (!r.ok) throw new Error(json?.error?.message ?? `Stripe ${r.status}`)
  return json
}

export async function POST(req: Request) {
  const started = Date.now()
  try {
    const key = testKey()
    if (!key) return Response.json({ error: "STRIPE_SECRET_KEY must be a test key (sk_test_...)" }, { status: 500 })
    const { name, amountCents, seller, image } = (await req.json()) as { name?: string; amountCents?: number; seller?: string; image?: string }
    if (!name || !Number.isInteger(amountCents) || (amountCents as number) < 50) {
      return Response.json({ error: "name and amountCents (integer, 50 or more) are required" }, { status: 400 })
    }
    const origin = new URL(req.url).origin
    const body: Record<string, string> = {
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(amountCents),
      "line_items[0][price_data][product_data][name]": name.slice(0, 250),
      "invoice_creation[enabled]": "true",
      success_url: `${origin}/test?paid={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/test?cancelled=1`,
    }
    if (seller) body["line_items[0][price_data][product_data][description]"] = `Sold by ${seller}`.slice(0, 250)
    if (image && /^https:\/\//.test(image)) body["line_items[0][price_data][product_data][images][0]"] = image
    const s = await stripe(key, "/checkout/sessions", body)
    return Response.json({ id: s.id, url: s.url, livemode: s.livemode, ms: Date.now() - started })
  } catch (error) {
    console.error("Twin checkout error:", error)
    return Response.json({ error: error instanceof Error ? error.message : "Checkout failed", ms: Date.now() - started }, { status: 502 })
  }
}

export async function GET(req: Request) {
  const started = Date.now()
  try {
    const key = testKey()
    if (!key) return Response.json({ error: "STRIPE_SECRET_KEY must be a test key (sk_test_...)" }, { status: 500 })
    const id = new URL(req.url).searchParams.get("session_id")
    if (!id || !/^cs_test_[A-Za-z0-9]+$/.test(id)) return Response.json({ error: "session_id (cs_test_...) is required" }, { status: 400 })
    const s = await stripe(key, `/checkout/sessions/${id}?expand[]=invoice`)
    const inv = s.invoice && typeof s.invoice === "object" ? s.invoice : null
    return Response.json({
      id: s.id, status: s.status, paid: s.payment_status === "paid", amountTotal: s.amount_total, currency: s.currency,
      invoice: inv ? { number: inv.number, pdf: inv.invoice_pdf, hosted: inv.hosted_invoice_url } : null,
      ms: Date.now() - started,
    })
  } catch (error) {
    console.error("Twin checkout status error:", error)
    return Response.json({ error: error instanceof Error ? error.message : "Lookup failed", ms: Date.now() - started }, { status: 502 })
  }
}

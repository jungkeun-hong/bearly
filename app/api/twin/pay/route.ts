// Bearly: agent payment in Stripe test mode, no typing.
// Step 1: mint a Shared Payment Token (SPT) scoped to this exact amount, valid 10 minutes (sandbox test helper).
// Step 2: the seller side charges that token with a PaymentIntent.
// If the SPT preview is not enabled on the account, falls back to a plain test-card PaymentIntent and says so.
// Refuses any key that is not a test key.

export const maxDuration = 20

const API = "https://api.stripe.com/v1"
const PREVIEW = "2026-09-30.preview"

async function stripe(key: string, path: string, body: Record<string, string>, preview = false) {
  const started = Date.now()
  const r = await fetch(API + path, {
    method: "POST",
    signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", ...(preview ? { "Stripe-Version": PREVIEW } : {}) },
    body: new URLSearchParams(body).toString(),
  })
  const json = await r.json()
  return { ok: r.ok, json, ms: Date.now() - started, error: r.ok ? null : (json?.error?.message as string) ?? `Stripe ${r.status}` }
}

export async function POST(req: Request) {
  const started = Date.now()
  try {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key || !key.startsWith("sk_test_")) return Response.json({ error: "STRIPE_SECRET_KEY must be a test key (sk_test_...)" }, { status: 500 })
    const { name, amountCents, seller } = (await req.json()) as { name?: string; amountCents?: number; seller?: string }
    if (!name || !Number.isInteger(amountCents) || (amountCents as number) < 50) {
      return Response.json({ error: "name and amountCents (integer, 50 or more) are required" }, { status: 400 })
    }
    const amount = String(amountCents)
    const description = `${name}${seller ? ` · ${seller}` : ""}`.slice(0, 500)
    const steps: { step: string; ok: boolean; ms: number; note?: string }[] = []

    const spt = await stripe(key, "/test_helpers/shared_payment/granted_tokens", {
      payment_method: "pm_card_visa",
      "usage_limits[currency]": "usd",
      "usage_limits[max_amount]": amount,
      "usage_limits[expires_at]": String(Math.floor(Date.now() / 1000) + 600),
    }, true)
    steps.push({ step: "token", ok: spt.ok, ms: spt.ms, note: spt.ok ? undefined : spt.error ?? undefined })

    const base = {
      amount, currency: "usd", confirm: "true", description, "expand[0]": "latest_charge",
      "automatic_payment_methods[enabled]": "true", "automatic_payment_methods[allow_redirects]": "never",
    }
    let via: "spt" | "test_card" = "spt"
    let pi = spt.ok
      ? await stripe(key, "/payment_intents", { ...base, "payment_method_data[shared_payment_granted_token]": spt.json.id }, true)
      : null
    if (pi) steps.push({ step: "charge_token", ok: pi.ok, ms: pi.ms, note: pi.ok ? undefined : pi.error ?? undefined })
    if (!pi || !pi.ok) {
      via = "test_card"
      pi = await stripe(key, "/payment_intents", { ...base, payment_method: "pm_card_visa" })
      steps.push({ step: "charge_test_card", ok: pi.ok, ms: pi.ms, note: pi.ok ? undefined : pi.error ?? undefined })
    }
    if (!pi.ok) return Response.json({ error: pi.error, steps, ms: Date.now() - started }, { status: 502 })

    const p = pi.json
    const charge = p.latest_charge && typeof p.latest_charge === "object" ? p.latest_charge : null
    return Response.json({
      via, paid: p.status === "succeeded", status: p.status, livemode: p.livemode, id: p.id,
      amount: p.amount, currency: p.currency, receiptUrl: charge?.receipt_url ?? null,
      card: charge?.payment_method_details?.card ? { brand: charge.payment_method_details.card.brand, last4: charge.payment_method_details.card.last4 } : null,
      tokenLimit: spt.ok ? { maxAmount: spt.json.usage_limits?.max_amount, expiresAt: spt.json.usage_limits?.expires_at } : null,
      steps, ms: Date.now() - started,
    })
  } catch (error) {
    console.error("Twin pay error:", error)
    return Response.json({ error: error instanceof Error ? error.message : "Payment failed", ms: Date.now() - started }, { status: 502 })
  }
}

import { generateText } from "ai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"

// Bearly: find something to buy from what the wearer said and what the glasses see.
// 1. If a frame is given, Gemini turns "what they said + what is in the frame" into a short shopping query
//    (brand, product type, colour). Without a frame, the spoken words are the query.
// 2. Shopify's Global Catalog (keyless MCP endpoint) returns real offers. We keep the ones in stock, sort by price.

export const maxDuration = 20

const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY })
const CATALOG = "https://catalog.shopify.com/api/ucp/mcp"
const PROFILE = "https://shopify.dev/ucp/agent-profiles/draft/valid-with-capabilities.json"

type Offer = { title: string; priceCents: number; seller: string; sellerUrl: string | null; url: string | null; image: string | null }

async function describe(said: string, frame: string, hint: string | null): Promise<string | null> {
  const { text } = await generateText({
    model: google("gemini-2.5-flash"),
    temperature: 0,
    abortSignal: AbortSignal.timeout(8000),
    providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
    messages: [{
      role: "user",
      content: [
        { type: "text", text: `Someone on camera says: "${said}".${hint ? ` A detector says the frame shows: ${hint}.` : ""}\nName the ONE product they mean as a shopping search query (3 to 8 words). If something is being held up to the camera, that is the product. Read the label: brand and product name exactly as printed, then size or colour if visible. Use brand or model text only if you can actually read it in the image. No quotes, no explanation. If you cannot tell what product they mean, answer exactly: UNKNOWN` },
        { type: "image", image: frame.replace(/^data:image\/\w+;base64,/, "") },
      ],
    }],
  })
  const q = text.trim().replace(/^["']|["']$/g, "")
  return !q || /^unknown$/i.test(q) ? null : q.slice(0, 80)
}

async function search(query: string): Promise<{ offers: Offer[]; total: number | null; dropped: number }> {
  const r = await fetch(CATALOG, {
    method: "POST", signal: AbortSignal.timeout(8000),
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "search_catalog", arguments: { meta: { "ucp-agent": { profile: PROFILE } }, catalog: { query, filters: { ships_to: { country: "US" } } } } },
    }),
  })
  if (!r.ok) throw new Error(`Shopify ${r.status}`)
  const raw = await r.text()
  const body = raw.trimStart().startsWith("{") ? raw : raw.split("\n").filter((l) => l.startsWith("data:")).pop()?.slice(5) ?? "{}"
  const result = JSON.parse(body).result ?? {}
  const data = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "{}")
  const offers: Offer[] = []
  for (const p of data.products ?? []) {
    const v = (p.variants ?? []).find((x: { availability?: { available?: boolean } }) => x.availability?.available !== false) ?? p.variants?.[0]
    const cents = v?.price?.amount ?? p.price_range?.min?.amount
    const currency = v?.price?.currency ?? p.price_range?.min?.currency
    if (!Number.isInteger(cents) || currency !== "USD") continue
    offers.push({
      title: String(p.title ?? v?.title ?? "").slice(0, 140), priceCents: cents,
      seller: v?.seller?.name ?? "", sellerUrl: v?.seller?.url ?? null, url: v?.url ?? null,
      image: p.media?.[0]?.preview?.url ?? p.media?.[0]?.url ?? v?.media?.[0]?.url ?? null,
    })
  }
  offers.sort((a, b) => a.priceCents - b.priceCents)
  // A listing far below the rest is nearly always a part, an accessory or a pricing mistake, and "cheapest" would pick it.
  // With four or more offers, anything under 15% of the median price is left out.
  if (offers.length >= 4) {
    const median = offers[Math.floor(offers.length / 2)].priceCents
    const kept = offers.filter((o) => o.priceCents >= median * 0.15)
    return { offers: kept, total: data.pagination?.total_count ?? null, dropped: offers.length - kept.length }
  }
  return { offers, total: data.pagination?.total_count ?? null, dropped: 0 }
}

export async function POST(req: Request) {
  const started = Date.now()
  try {
    const { said, frame, hint, query: given, lookOnly } = (await req.json()) as { said?: string; frame?: string | null; hint?: string | null; query?: string; lookOnly?: boolean }
    if (!said && !given) return Response.json({ error: "said or query is required" }, { status: 400 })
    const steps: { step: string; ms: number; note?: string }[] = []
    let query = given?.trim() || ""
    if (!query && frame && process.env.GEMINI_API_KEY) {
      const t = Date.now()
      try { query = (await describe(said ?? "", frame, hint ?? null)) ?? "" } catch (e) { steps.push({ step: "look", ms: Date.now() - t, note: e instanceof Error ? e.message : "failed" }) }
      if (query) steps.push({ step: "look", ms: Date.now() - t })
    }
    if (!query) query = (said ?? "").replace(/\b(find|me|the|a|an|cheapest|cheaper|buy|order|get|look ?up|search|for|this|that|one|please|replacement|of|like)\b/gi, " ").replace(/\s+/g, " ").trim() || (hint ?? "")
    if (!query) return Response.json({ error: "I could not tell what item you mean", steps, ms: Date.now() - started }, { status: 422 })
    if (lookOnly) return Response.json({ query, steps, ms: Date.now() - started })
    const t = Date.now()
    const { offers, total, dropped } = await search(query)
    steps.push({ step: "shopify", ms: Date.now() - t })
    return Response.json({ query, offers: offers.slice(0, 8), found: offers.length, total, dropped, steps, ms: Date.now() - started })
  } catch (error) {
    console.error("Twin shop error:", error)
    return Response.json({ error: error instanceof Error ? error.message : "Search failed", ms: Date.now() - started }, { status: 502 })
  }
}

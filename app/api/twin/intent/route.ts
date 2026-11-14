// Bearly: what does one spoken sentence ask for? Jev (TypeSafe System One) answers in about 0.1 s.
// The page falls back to its own word matching if this fails.

export const maxDuration = 10

const CRITERIA: Record<string, string> = {
  find: "asks to find, identify, look up, price or shop for a thing, for example 'find this', 'what is this', 'how much is this', 'get me the cheapest one'",
  buy: "approves a purchase: 'yes', 'buy it', 'order it', 'go ahead', 'do it'",
  next: "asks for another, the next or a different option",
  skip: "declines the offer: 'no', 'skip', 'never mind', 'not that'",
  email: "asks to email or send the invoice or the report to a manager or another person",
  invoice: "asks to see or show the invoice or the receipt",
  report: "asks to see or show the report",
  close: "asks to close or hide what is being shown",
  note: "states an observation about the condition of a piece of equipment or an item, something worth writing in an inspection report",
  chat: "a greeting, small talk, a mic test, an unclear or unfinished sentence, words in another language, or not meant for the shopping assistant",
}

export async function POST(req: Request) {
  const started = Date.now()
  try {
    const { text } = (await req.json()) as { text?: string }
    const key = process.env.JEV_API_KEY
    if (!text || !key) return Response.json({ error: "text and JEV_API_KEY are required" }, { status: 400 })
    const quote = "the sentence in `sentence`"
    const r = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST", signal: AbortSignal.timeout(3000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.JEV_MODEL || "jev-latest",
        state: { sentence: text, speaker: "a person wearing camera glasses, talking to a shopping assistant about what they are looking at" },
        questions: {
          intent: { type: "choice", instructions: `What does ${quote} ask for?`, criteria: CRITERIA },
          email: { type: "noul", instructions: `${quote} asks, possibly among other things, to email or send something to a manager or another person.` },
        },
      }),
    })
    if (!r.ok) return Response.json({ error: `Jev ${r.status}`, ms: Date.now() - started }, { status: 502 })
    const a = (await r.json()).answers ?? {}
    console.log(`[vb] intent ${a.intent?.choice} ${(a.intent?.confidence ?? 0).toFixed(2)} for ${JSON.stringify(text)}`)
    return Response.json({ intent: a.intent?.choice ?? "chat", confidence: a.intent?.confidence ?? 0, alsoEmail: (a.email?.noul ?? 0) > 0.6, ms: Date.now() - started })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "failed", ms: Date.now() - started }, { status: 502 })
  }
}

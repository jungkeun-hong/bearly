// VibeBuying: what a wrist tap means, decided in one place so it can be tested without a band.
//
// Rules:
//  - A double tap approves a purchase ONLY while an offer is waiting for a yes AND the assistant asked within the
//    last `windowMs`. Outside that window a double tap does nothing, so walking or clapping cannot buy anything.
//  - One approval per question: after an approval the gate closes until the next question.
//  - A single tap cuts the assistant off, only while it is talking.
//  - Taps closer together than `debounceMs` count once (a double tap can also arrive as taps).

export function createBandGate({ windowMs = 10_000, debounceMs = 700 } = {}) {
  let armedAt = -Infinity // when the assistant last asked "do you want it?"
  let lastAt = -Infinity
  return {
    /** Call when an offer is put to the wearer and a yes would buy it. */
    arm(now) { armedAt = now },
    /** Call when the offer is gone: bought, skipped, replaced, or the session ended. */
    disarm() { armedAt = -Infinity },
    /** How long a double tap still counts, in ms. 0 when closed. */
    remaining(now) { return Math.max(0, armedAt + windowMs - now) },
    /**
     * @param {"tap"|"double-tap"} kind
     * @param {{ now: number, offerOpen: boolean, speaking: boolean }} state
     * @returns {"approve"|"cut"|null}
     */
    onTap(kind, { now, offerOpen, speaking }) {
      if (now - lastAt < debounceMs) return null
      if (kind === "double-tap") {
        if (!offerOpen || now - armedAt > windowMs || now < armedAt) return null
        lastAt = now
        armedAt = -Infinity
        return "approve"
      }
      if (kind === "tap" && speaking) { lastAt = now; return "cut" }
      return null
    },
  }
}

/** The band light for each state of the stage. r, g, b 0..255; pattern as in the band contract. */
export const BAND_LIGHT = {
  idle: { r: 0, g: 0, b: 0, pattern: "off", periodMs: 1000 },
  listening: { r: 0, g: 80, b: 255, pattern: "solid", periodMs: 1000 },
  working: { r: 255, g: 255, b: 255, pattern: "blink", periodMs: 400 },
  asking: { r: 255, g: 180, b: 0, pattern: "breathe", periodMs: 1500 },
  paid: { r: 0, g: 255, b: 60, pattern: "solid", periodMs: 1000 },
  failed: { r: 255, g: 0, b: 0, pattern: "flash", periodMs: 600 },
}

/** Which light to show. First match wins. */
export function bandLightFor({ live, working, asking, justPaid, justFailed }) {
  if (justFailed) return "failed"
  if (justPaid) return "paid"
  if (asking) return "asking"
  if (working) return "working"
  return live ? "listening" : "idle"
}

# Bearly

**Too lazy to shop? Just say yup.**

<img src="assets/thumbnail.jpg" alt="Bearly" width="640">

Put on Meta glasses, hold up a product and say what you want. An AI that sees what you see finds it in real shops,
reads the price back to you, and buys it when you say yes. Then it writes the invoice and a walk report and drafts the
email to your manager. Nothing is typed.

Built for **VexoHacks** (AI wearables, YC, 14 Nov 2026).

> **Payments are Stripe test mode only.** No real money moves and no order is placed with the shop. The payment routes
> refuse any key that does not start with `sk_test_`.

## What it does

| You do | It does |
|---|---|
| Hold up a bag of chips: "What is this? Find me the cheapest one." | Gemini reads the label, Shopify's catalog returns real offers, the cheapest sensible one lands on screen as a card with photos. |
| "Buy it." | A one-time Stripe Shared Payment Token, capped at that price, is created and charged in test mode (about 1.2 s). |
| "Email my manager the invoice and the report." | An invoice and a walk report are built from the session and shown as an email draft. |
| "The gauge reads 62 psi, write that down." | The value is saved and pinned on the photo of what you were looking at. |
| "Show me the board." | One screen with everything seen, asked and bought, plus annotated photos. |

While you talk, the screen shows boxes on what you look at (Jev), a stream of what you have seen, your position in a 3D room
(phone steps + glasses head turn), and each request with the steps the agent is taking, in plain sentences.

## How it works

```
Meta glasses --Bluetooth + Wi-Fi--> iPhone app (ios/) --LiveKit--> this web page (/demo) --> Gemini Live (voice + vision + tools)
                                     + phone steps/compass                                  --> Jev (boxes)  --> Shopify catalog --> Stripe (test)
```

- **Gemini Live** (`gemini-3.8-live`): one realtime session hears you, sees one frame per second, talks back and calls tools:
  `find_product`, `select_offer`, `next_offer`, `buy_selected`, `skip_offer`, `email_manager`, `show_document`, `add_note`, `record_reading`.
  A short-lived token is minted server side, so the key never reaches the browser.
- **Jev** (TypeSafe System One): draws boxes on what is in view. Jev picks from categories and cannot read a brand, so Gemini names
  the product and Jev then follows that exact thing.
- **Shopify Global Catalog**: real products and prices (no key needed).
- **Stripe**: Shared Payment Tokens in a sandbox; falls back to a test-card PaymentIntent if the preview is not enabled.
- **ElevenLabs**: speech to text for the older Mic button, and a spoken-reply route.
- **LiveKit**: carries the glasses camera and microphone from the phone to the page.
- **Meta Wearables Device Access Toolkit** (DAT 1.0.1): the glasses camera and motion sensor, in the iOS app.
- An **echo gate** keeps the assistant from hearing itself on a loudspeaker; a **noise gate** keeps a crowded room from
  swallowing your voice. Space bar or a tap on the picture cuts the assistant off.

## Run it

Web (Node 20+):

```bash
npm install
cp .env.example .env.local   # fill in the keys
npm run dev                  # http://localhost:3127/demo
```

Open `/demo`. It shows this computer's camera right away and switches to the glasses when they start sending.
Press **Talk live** and speak.

Phone app (iOS 17.2+, a real iPhone, Meta glasses with Developer Mode on):

```bash
brew install xcodegen
cd ios && DEVELOPMENT_TEAM=<your Apple team id> xcodegen generate && open Bearly.xcodeproj
```

1. Meta AI app > Settings > App Info > tap the version 5 times to enable Developer Mode, then push the settings to the glasses.
2. Run **Bearly**, tap **Register with Meta AI**, then **Send to stage** with the stage computer's address in the field.
3. Close any other app that holds the glasses camera. Only one app can have it.

## Honest limits

- Position is counted steps plus compass, so it drifts after a few minutes. Use **Place me** to line the rebuilt room up again.
- "Cheapest" is filtered for obviously wrong prices, but a shop's title may not be the exact same product. The assistant says when it is a close match.
- The manager email is drafted on screen; sending it is not connected.
- Meta's glasses motion API is beta; the microphone reaches the phone as Bluetooth call audio, so it is lower quality than a phone mic.
- Optional room assets (`public/twin-local/world.spz`, `bear.png`, `recon-yc.json`) are local only and not in this repo.

## Layout

```
app/demo            the stage page
app/api/twin/*      server routes: live-token, livekit-token, see (Jev), shop, pay, hear, speak, intent, depth, log
components/twin     report-app.tsx (the page), pin-room.tsx (3D view)
ios/                Bearly app: glasses camera + mic + sensors into a LiveKit room
```

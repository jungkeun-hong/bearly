# Bearly

**A hands-free AI agent with eyes and ears. More deals, first visit.**

<img src="assets/cover.jpg" alt="Bearly" width="640">

<img src="assets/architecture.png" alt="Bearly architecture: input, stage, agent, tools, output" width="900">

## The problem

An HVAC technician stands in a customer's house with both hands inside a dead AC unit. He can see the failed part, but
the quote comes later, from the office. One HVAC shop told us that can take up to 24 hours. By then the homeowner has
called someone else.

## What Bearly does

Smart glasses are Bearly's eyes. A Vexo band on the wrist is its ears. The tech just talks.

- "Can you find the cheapest price?" Bearly reads the label and finds the lowest real offer on Shopify.
- "Quote it." A customer quote appears: part, margin, labor, total.
- "Can you buy this?" Bearly pays with a one-time Stripe token capped at that price.
- "Send this to my manager." The invoice and walk report go out as a real email (in this demo, to our own inbox).

No screen touched, no typing. The name is a pun: you *barely* lift a finger, and the helper is a bear.

Built for VexoHacks, the AI wearables hackathon at Y Combinator, 14 Nov 2026.

> Payments run in **Stripe test mode**, so no real money is ever spent.

## What it sounds like

> Tech: "That's the UT."
> Bearly: "The UNI-T clamp meter is $34.99 at Evalm. Would you like me to get it for you?"
> Tech: "I just input that in my invoice."
> Bearly: "The quote total is $161.99. Would you like to order the part?"
> Tech: "Send this to my manager."
> Bearly: "I've drafted the email with the invoice attached. Should I send it?"

Along the way the tech can also say things like "The gauge reads 62 psi, write that down" and Bearly saves it with a
photo of what he was looking at. Say "show me the board" to see everything from the visit on one screen.

## Challenge we hit

The glasses kept refusing the camera. The phone microphone was opening a call-audio link (HFP) to them, and they turn
down camera sessions while it is up. Moving the voice to the Vexo band fixed it.

## What you see on the screen

- **Left:** what your glasses see, with a box around the things you look at.
- **Middle:** a little bear that walks around a 3D room as you walk, and a list of things you looked at.
- **Right:** each thing you asked for, with the steps Bearly took, written as plain sentences ("I'm searching Shopify..."),
  and the quote or invoice when it is ready.

## What you need

- Meta smart glasses (Ray-Ban Meta or Oakley Meta) with Developer Mode turned on
- An iPhone
- A laptop with Chrome (this is the screen the audience watches)
- A Vexo band, for talking to Bearly from your wrist (optional; the laptop microphone also works)
- A few free accounts for the keys listed in `.env.example`

## Try it

**1. Start the screen on your laptop**

```bash
npm install
cp .env.example .env.local     # then paste your keys into .env.local
npm run dev
```

Open http://localhost:3127/demo. It shows your laptop camera right away. Press **Talk live** and start talking.

Emails (the quote and the manager email) go only to your own inbox. To turn that on, put the path of a Google login file
in `GOOGLE_TOKEN_FILE` (see `.env.example`). English subtitles need a `DEEPGRAM_API_KEY`.

**Using the Vexo band (optional)**

The band connects to Chrome over Bluetooth. Turn on two Chrome flags, then restart Chrome:

- `chrome://flags/#enable-web-bluetooth-new-permissions-backend`
- `chrome://flags/#enable-experimental-web-platform-features`

Then press the band button on the page and pick your band.

**2. Connect your glasses (optional, but it is the point)**

```bash
brew install xcodegen
cd ios
DEVELOPMENT_TEAM=<your Apple team id> xcodegen generate
open Bearly.xcodeproj
```

Run the app on your iPhone. In the Meta AI app, turn on Developer Mode (Settings, App Info, tap the version number 5 times).
In Bearly, tap **Register with Meta AI**, then **Start**. One tap starts everything: the glasses camera goes to the stage
and the stage starts listening. Your glasses view replaces the laptop camera.

Do not let the phone use the glasses as its microphone. A Bluetooth call (HFP) makes the glasses refuse the camera
session (see issue #342 in meta-wearables-dat-ios). Talk to the band or the laptop instead.

If the glasses will not connect, close any other app that is using them. Only one app can use the glasses at a time.

## How it works, in plain words

The diagram at the top shows the whole flow.

1. The glasses send what they see and hear to your iPhone, and the phone sends it to the laptop.
2. **Gemini Live** listens, looks, talks back and decides what to do.
3. **Jev** draws the boxes around things in the picture.
4. Bearly searches real shops through the **Shopify catalog** and shows you the cheapest good match.
5. Bearly builds the customer quote: part price, margin, labor, total.
6. When you say yes, **Stripe** pays for it with a one-time token capped at that price.
7. **LiveKit** carries the video and sound from the phone to the laptop.
8. **ElevenLabs** handles speech to text for the backup microphone button.
9. **Deepgram** writes the English subtitles of what you say.
10. **Gmail** sends the quote and the manager email to your own inbox, never to anyone else.
11. The **Vexo band** is the microphone on your wrist, so you can talk with your hands full.

## Where things are

```
app/demo           the screen
app/api/twin       the small server pieces: search, pay, listen, speak
components/twin    the screen's code and the 3D room
ios                the iPhone app
assets             the bear
```

# Bearly

**Too lazy to shop? Say "Hey Bearly."**

<img src="assets/thumbnail.jpg" alt="Bearly" width="640">

Bearly is a shopping helper that lives in your smart glasses. Look at something, say what you want, and it finds it,
buys it and writes down what happened. You never touch a screen or type a word.

The name is a pun. You *barely* lift a finger, and the helper is a bear.

It was built for VexoHacks, the AI wearables hackathon at Y Combinator, 14 Nov 2026.

> Payments run in **Stripe test mode**, so no real money is ever spent.

## What it feels like

> You: "Hey Bearly, what is this? Find me the cheapest one."
> Bearly: "That's a bag of chips. The cheapest I found is on your screen. Want it?"
> You: "Quote it."
> Bearly: "The quote is on your screen: the part, labor and margin."
> You: "Yup."
> Bearly: "Bought it."
> You: "Email my manager the invoice."
> Bearly: "Done, it is in your inbox."

Along the way you can also say things like "The gauge reads 62 psi, write that down" and Bearly saves it with a photo of
what you were looking at. Say "show me the board" to see everything from the session on one screen.

## What you see on the screen

- **Left:** what your glasses see, with a box around the things you look at.
- **Middle:** a little bear that walks around a 3D room as you walk, and a list of things you looked at.
- **Right:** each thing you asked for, with the steps Bearly took, written as plain sentences ("I'm searching Shopify...").

## What you need

- Meta smart glasses (Ray-Ban Meta or Oakley Meta) with Developer Mode turned on
- An iPhone
- A laptop with Chrome (this is the screen the audience watches)
- Optional: a Vexo band, for talking to Bearly from your wrist
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

<img src="assets/architecture.png" alt="Bearly architecture: input, stage, agent, tools, output" width="900">

1. The glasses send what they see and hear to your iPhone, and the phone sends it to the laptop.
2. **Gemini Live** listens, looks, talks back and decides what to do.
3. **Jev** draws the boxes around things in the picture.
4. Bearly searches real shops through the **Shopify catalog** and shows you the cheapest good match.
5. When you say yes, **Stripe** pays for it.
6. **LiveKit** carries the video and sound from the phone to the laptop.
7. **ElevenLabs** handles speech to text for the backup microphone button.
8. **Deepgram** writes the English subtitles of what you say.
9. **Gmail** sends the quote and the manager email to your own inbox, never to anyone else.
10. The **Vexo band** is the microphone on your wrist, so you can talk with your hands full.

## Where things are

```
app/demo           the screen
app/api/twin       the small server pieces: search, pay, listen, speak
components/twin    the screen's code and the 3D room
ios                the iPhone app
assets             the bear
```

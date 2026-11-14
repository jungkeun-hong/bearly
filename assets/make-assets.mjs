// Builds the icon, the transparent mark and the Devpost thumbnail from the two bear cutouts in assets/source.
// The cutouts are the same plush bear as the 3D one in the scene (VEXO cap, black woven bands). Flat backgrounds only.
//   node assets/make-assets.mjs
import sharp from "sharp"

const CREAM = "#F0DCB8", INK = "#141416", STEEL = "#B9B9B5"

// App icon: opaque square (iOS does not take transparency), one flat color, no effects.
const portrait = await sharp("assets/source/bear-portrait.png").resize(942, 942).toBuffer() // bottom edge bleeds off the canvas
await sharp({ create: { width: 1024, height: 1024, channels: 3, background: CREAM } })
  .composite([{ input: portrait, left: 41, top: 82 }]).removeAlpha().png().toFile("assets/icon.png")

// Transparent cutouts for slides and the README.
await sharp("assets/source/bear-full.png").png().toFile("assets/bear-mark.png")

// Devpost thumbnail, 3:2.
const full = await sharp("assets/source/bear-full.png").resize({ height: 960 }).toBuffer()
const w = (await sharp(full).metadata()).width
const text = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="1000">
  <text x="90" y="470" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-weight="800" font-size="190" fill="${CREAM}">Bearly</text>
  <text x="96" y="560" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-weight="500" font-size="46" fill="${STEEL}">Too lazy to shop? Just say yup.</text>
</svg>`)
await sharp({ create: { width: 1500, height: 1000, channels: 3, background: INK } })
  .composite([{ input: full, left: 1500 - w - 90, top: 30 }, { input: text, left: 0, top: 0 }]).jpeg({ quality: 92 }).toFile("assets/thumbnail.jpg")
console.log("done")

// PWAアイコンをSVGから生成する。実行: node scripts/make-icons.mjs
// maskable版はAndroidが最大20%を切り落とすため、図柄を内側60%に収める。
import sharp from "sharp";
import { mkdir } from "node:fs/promises";

const INK = "#070C0B";
const SIGNAL = "#4FD1A5";
const BRAND = "#0F6E56";
const WARN = "#F2B441";

/** inset: 図柄を収める比率（1.0でキャンバスいっぱい） */
function mark(inset) {
  const c = 256;
  const r = 256 * inset;
  const ri = r * 0.62;
  const w = 512 * 0.045;
  const tickIn = r * 0.78;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${INK}"/>
  <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${SIGNAL}" stroke-width="${w}"/>
  <circle cx="${c}" cy="${c}" r="${ri}" fill="none" stroke="${BRAND}" stroke-width="${512 * 0.03}"/>
  <g stroke="${SIGNAL}" stroke-width="${w}" stroke-linecap="butt">
    <path d="M${c} ${c - tickIn}V${c - r}M${c} ${c + tickIn}V${c + r}M${c - tickIn} ${c}H${c - r}M${c + tickIn} ${c}H${c + r}"/>
  </g>
  <circle cx="${c}" cy="${c}" r="${r * 0.2}" fill="${SIGNAL}"/>
  <circle cx="${c + r * 0.46}" cy="${c - r * 0.46}" r="${r * 0.11}" fill="${WARN}"/>
</svg>`;
}

const out = "public";
await mkdir(out, { recursive: true });

const jobs = [
  { file: "icon-192.png", size: 192, inset: 0.76 },
  { file: "icon-512.png", size: 512, inset: 0.76 },
  { file: "apple-touch-icon.png", size: 180, inset: 0.74 },
  { file: "icon-maskable-512.png", size: 512, inset: 0.56 },
];

for (const j of jobs) {
  await sharp(Buffer.from(mark(j.inset))).resize(j.size, j.size).png().toFile(`${out}/${j.file}`);
  console.log("generated", j.file);
}
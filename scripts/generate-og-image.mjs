// Draws the link preview image of spec 10.2: a small square PNG (Discord shows it as the thumbnail of a
// "summary" card), two dice on a gold ribbon, nothing about any room. Pure Node, with a minimal PNG encoder on node:zlib. Deterministic pixels; the compressed bytes depend on the zlib build. Usage: node scripts/generate-og-image.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync, inflateSync } from "node:zlib";

const W = 256;
const H = 256;
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
// The tokens of src/web/style.css: dark theme background, gold, the cream dice with teal and coral pips.
const night = hex("#0e2629");
const nightTop = hex("#1e4a4f");
const gold = hex("#ffd23f");
const cream = hex("#fff8e7");
const creamEdge = hex("#e3d3a8");
const teal = hex("#14615c");
const coral = hex("#d45233");

// Signed distances in pixels; coverage turns them into anti-aliased edges.
const box = (x, y, hw, hh, r) => {
  const qx = Math.abs(x) - hw + r;
  const qy = Math.abs(y) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const coverage = (d) => Math.min(1, Math.max(0, 0.5 - d));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

const PIPS = { 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], 6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]] };
const dice = [
  { cx: 74, cy: 112, size: 84, angle: -0.2, value: 5, pip: teal },
  { cx: 180, cy: 126, size: 84, angle: 0.15, value: 6, pip: coral },
];

function shade(x, y) {
  // Night sky, a little lighter at the top, with a warm glow behind the dice.
  let c = mix(nightTop, night, y / H);
  const glow = Math.exp(-(((x - 128) / 120) ** 2 + ((y - 120) / 100) ** 2));
  c = mix(c, gold, 0.12 * glow);
  // The ribbon a gift is tied with.
  c = mix(c, gold, coverage(Math.abs(y - 182) - 5) * 0.9);
  for (const d of dice) {
    const h = d.size / 2;
    // Soft shadow under the die.
    const shadow = Math.exp(-(((x - d.cx - h * 0.1) / (h * 1.05)) ** 2 + ((y - d.cy - h * 1.05) / (h * 0.18)) ** 2));
    c = mix(c, [0, 0, 0], 0.45 * shadow);
    const cos = Math.cos(-d.angle);
    const sin = Math.sin(-d.angle);
    const px = (x - d.cx) * cos - (y - d.cy) * sin;
    const py = (x - d.cx) * sin + (y - d.cy) * cos;
    const edge = box(px, py, h, h, d.size * 0.16);
    const body = coverage(edge);
    if (body === 0) continue;
    const face = mix(cream, creamEdge, Math.min(1, Math.max(0, (edge + h * 0.15) / (h * 0.15))) * 0.8 + (py / h + 1) * 0.08);
    let die = face;
    for (const [gx, gy] of PIPS[d.value]) {
      die = mix(die, d.pip, coverage(Math.hypot(px - gx * h * 0.5, py - gy * h * 0.5) - d.size * 0.085));
    }
    c = mix(c, die, body);
  }
  return c;
}

// Each row starts with filter type 2 (Up): the difference to the row above, which compresses well here.
const rowBytes = W * 3 + 1;
const raw = Buffer.alloc(rowBytes * H);
let prev = new Uint8Array(W * 3);
for (let y = 0; y < H; y++) {
  const row = new Uint8Array(W * 3);
  for (let x = 0; x < W; x++) {
    // 4×4 supersampling: smooth edges at this small size.
    const offsets = [0.125, 0.375, 0.625, 0.875];
    const s = offsets.flatMap((dy) => offsets.map((dx) => shade(x + dx, y + dy)));
    for (let ch = 0; ch < 3; ch++) row[x * 3 + ch] = Math.round(s.reduce((sum, c) => sum + c[ch], 0) / s.length);
  }
  raw[y * rowBytes] = 2;
  for (let i = 0; i < row.length; i++) raw[y * rowBytes + 1 + i] = (row[i] - prev[i]) & 0xff;
  prev = row;
}

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(W, 0);
header.writeUInt32BE(H, 4);
header.set([8, 2, 0, 0, 0], 8); // 8 bit, RGB, deflate, standard filters, no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const target = new URL("../src/web/public/og.png", import.meta.url);

// --check (CI): deflate output differs between zlib builds (Node's own in CI, zlib-ng in some distributions'
// Node), so the same pixels give other bytes. Compares header and pixels instead, which every zlib inflates
// alike; exits 1 if the committed image is not what this script draws.
if (process.argv.includes("--check")) {
  const file = readFileSync(target);
  const chunks = { IHDR: [], IDAT: [] };
  for (let at = 8; at < file.length; ) {
    const length = file.readUInt32BE(at);
    const type = file.toString("latin1", at + 4, at + 8);
    chunks[type]?.push(file.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const same = Buffer.concat(chunks.IHDR).equals(header) && inflateSync(Buffer.concat(chunks.IDAT)).equals(raw);
  console.log(same ? "og.png: matches the script" : "og.png: differs from what the script draws; run it and commit the result");
  process.exit(same ? 0 : 1);
}
writeFileSync(target, png);
console.log(`og.png: ${png.length} bytes`);

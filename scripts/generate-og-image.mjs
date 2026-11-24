// Draws the link preview image of spec 10.2 (1200×630 PNG): two dice on a gold ribbon, nothing about any
// room. Pure Node, with a minimal PNG encoder on node:zlib. Deterministic. Usage: node scripts/generate-og-image.mjs
import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const W = 1200;
const H = 630;
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
// The dark theme tokens of src/web/style.css.
const night = hex("#0f1d27");
const nightTop = hex("#18303f");
const gold = hex("#e2b85a");
const ivory = hex("#fbf6ea");
const ivoryEdge = hex("#ddd3bd");
const ink = hex("#1b2a36");
const cranberry = hex("#b3263e");

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
  { cx: 480, cy: 300, size: 250, angle: -0.2, value: 5, pip: ink },
  { cx: 760, cy: 330, size: 250, angle: 0.15, value: 6, pip: cranberry },
];

function shade(x, y) {
  // Night sky, a little lighter at the top, with a warm glow behind the dice.
  let c = mix(nightTop, night, y / H);
  const glow = Math.exp(-(((x - 620) / 420) ** 2 + ((y - 320) / 260) ** 2));
  c = mix(c, gold, 0.12 * glow);
  // The ribbon a gift is tied with.
  c = mix(c, gold, coverage(Math.abs(y - 470) - 16) * 0.9);
  for (const d of dice) {
    const h = d.size / 2;
    // Soft shadow under the die.
    const shadow = Math.exp(-(((x - d.cx - 14) / (h * 1.05)) ** 2 + ((y - d.cy - h - 6) / 22) ** 2));
    c = mix(c, [0, 0, 0], 0.45 * shadow);
    const cos = Math.cos(-d.angle);
    const sin = Math.sin(-d.angle);
    const px = (x - d.cx) * cos - (y - d.cy) * sin;
    const py = (x - d.cx) * sin + (y - d.cy) * cos;
    const edge = box(px, py, h, h, d.size * 0.16);
    const body = coverage(edge);
    if (body === 0) continue;
    const face = mix(ivory, ivoryEdge, Math.min(1, Math.max(0, (edge + 18) / 18)) * 0.8 + (py / h + 1) * 0.08);
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
    // 2×2 supersampling for smooth gradients and edges.
    const s = [0.25, 0.75].flatMap((dy) => [0.25, 0.75].map((dx) => shade(x + dx, y + dy)));
    for (let ch = 0; ch < 3; ch++) row[x * 3 + ch] = Math.round(s.reduce((sum, c) => sum + c[ch], 0) / 4);
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
writeFileSync(new URL("../src/web/public/og.png", import.meta.url), png);
console.log(`og.png: ${png.length} bytes`);

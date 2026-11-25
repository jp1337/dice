// Draws the link preview image of spec 10.2: a small square PNG (Discord shows it as the thumbnail of a
// "summary" card), two dice on a walnut table under icicles, snowy pines and sky, nothing about any room. Pixel art in the
// app's look: drawn on a 64×64 grid with the colours of src/web/style.css, scaled ×4 without smoothing.
// Pure Node, with a minimal PNG encoder on node:zlib. Deterministic pixels; the compressed bytes depend on
// the zlib build. Usage: node scripts/generate-og-image.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync, inflateSync } from "node:zlib";

const GRID = 64;
const SCALE = 4;
const W = GRID * SCALE;
const H = GRID * SCALE;
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
// Tokens of src/web/style.css (light theme) and the colours of its pixel tiles (icicles, pines).
const c = {
  sky: hex("#b6d7f2"),
  skyLow: hex("#d3e7f7"),
  sun: hex("#eef6fd"),
  snow: hex("#f4f7fb"),
  snowLip: hex("#f6faff"),
  snowShade: hex("#d5e3f1"),
  fleck: hex("#c3d2e4"),
  iceShade: hex("#a9c8e8"),
  ice: hex("#eef8ff"),
  iceDeep: hex("#3b78c0"),
  pine: hex("#25604f"),
  pineDark: hex("#163d36"),
  pineLight: hex("#3f8468"),
  trunk: hex("#4a332b"),
  plank: hex("#5e4238"),
  wood: hex("#6a4a40"),
  woodLight: hex("#8a6a5e"),
  woodDark: hex("#3a2722"),
  face: hex("#fbfdff"),
  faceShade: hex("#c3d7ed"),
  ink: hex("#1b2a40"),
  berry: hex("#a8304a"),
};

const grid = Array.from({ length: GRID }, () => Array.from({ length: GRID }, () => c.sky));
const rect = (x, y, w, h, colour) => {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < GRID && j < GRID) grid[j][i] = colour;
};

// Sky in two bands, a pale sun, the snowfield with specks below the horizon.
rect(0, 14, GRID, 16, c.skyLow);
rect(48, 14, 6, 6, c.sun);
rect(47, 15, 8, 4, c.sun);
rect(0, 30, GRID, 10, c.snow);
rect(0, 30, GRID, 1, c.snowShade);
for (const [x, y] of [[4, 33], [19, 36], [27, 32], [41, 37], [52, 33], [60, 36], [11, 38]]) rect(x, y, 1, 1, c.fleck);
// Snowy pines on the horizon: tiers of evergreen, snow on top of each, a trunk.
function pine(cx, tiers) {
  const top = 29 - tiers * 3 - 1;
  rect(cx, top, 1, 1, c.snowLip);
  for (let t = 0; t < tiers; t++) {
    const y = top + 1 + t * 3;
    rect(cx - t, y, 2 * t + 1, 1, c.snowLip);
    rect(cx - t - 1, y + 1, 2 * t + 3, 1, c.pine);
    rect(cx - t - 1, y + 1, 1, 1, c.pineLight);
    rect(cx - t - 1, y + 2, 2 * t + 3, 1, c.pineDark);
  }
  rect(cx, 29, 1, 1, c.trunk);
}
for (const [x, t] of [[4, 3], [10, 2], [24, 2], [44, 3], [58, 3], [52, 2]]) pine(x, t);
// Icicles from a lip of snow along the top edge.
rect(0, 0, GRID, 2, c.snowLip);
rect(0, 2, GRID, 1, c.iceShade);
for (const [x, len] of [[1, 6], [6, 3], [10, 8], [16, 4], [21, 3], [25, 7], [31, 4], [36, 8], [42, 3], [47, 6], [53, 4], [58, 7]]) {
  const wide = Math.ceil(len / 2);
  rect(x, 3, 2, wide, c.ice);
  rect(x + 2, 3, 1, wide, c.iceDeep);
  rect(x + 1, 3 + wide, 1, len - wide - 1, c.ice);
  rect(x + 2, 3 + wide, 1, len - wide - 1, c.iceDeep);
  rect(x + 1, 2 + len, 1, 1, c.iceDeep);
}
// Walnut cabin table: boards with seams, a light top edge, grain.
rect(0, 40, GRID, 24, c.plank);
rect(0, 40, GRID, 1, c.woodLight);
for (const y of [47, 55]) rect(0, y, GRID, 1, c.woodDark);
for (const [x, y, w] of [[5, 43, 9], [30, 44, 12], [50, 42, 8], [14, 50, 10], [40, 51, 14], [3, 58, 12], [26, 59, 9], [48, 60, 11]]) rect(x, y, w, 1, c.wood);

// A die: 17×17 with an outline and notched corners, a shaded bottom and right edge, square 3×3 pips.
const PIPS = { 5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]], 6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]] };
function die(x, y, value, pip) {
  rect(x + 2, y + 17, 17, 2, c.woodDark); // shadow on the table
  rect(x + 1, y, 15, 17, c.ink);
  rect(x, y + 1, 17, 15, c.ink);
  rect(x + 1, y + 1, 15, 15, c.face);
  rect(x + 1, y + 15, 15, 1, c.faceShade);
  rect(x + 15, y + 1, 1, 15, c.faceShade);
  for (const [gx, gy] of PIPS[value]) rect(x + 3 + gx * 4, y + 3 + gy * 4, 3, 3, pip);
}
die(11, 27, 5, c.ink);
die(35, 31, 6, c.berry);

// Each row starts with filter type 2 (Up): the difference to the row above, which compresses well here.
const rowBytes = W * 3 + 1;
const raw = Buffer.alloc(rowBytes * H);
let prev = new Uint8Array(W * 3);
for (let y = 0; y < H; y++) {
  const row = new Uint8Array(W * 3);
  for (let x = 0; x < W; x++) row.set(grid[Math.floor(y / SCALE)][Math.floor(x / SCALE)], x * 3);
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

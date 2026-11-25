// Draws the link preview image of spec 10.2: a small square PNG (Discord shows it as the thumbnail of a
// "summary" card), two dice on a plank table under bunting and sky, nothing about any room. Pixel art in the
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
// Tokens of src/web/style.css (light theme).
const c = {
  sky: hex("#bcd8ee"),
  cloud: hex("#ffffff"),
  snow: hex("#f2f7fc"),
  snowShade: hex("#b9cde4"),
  plank: hex("#34507a"),
  wood: hex("#3e5c86"),
  woodLight: hex("#6a88b0"),
  woodDark: hex("#1f2f4d"),
  face: hex("#fbfdff"),
  faceShade: hex("#dbe7f5"),
  ink: hex("#1f2f4d"),
  berry: hex("#a8304a"),
  holly: hex("#5a9a3e"),
  wheat: hex("#f2c14e"),
};

const grid = Array.from({ length: GRID }, () => Array.from({ length: GRID }, () => c.sky));
const rect = (x, y, w, h, colour) => {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < GRID && j < GRID) grid[j][i] = colour;
};

// Clouds.
rect(8, 12, 10, 3, c.cloud);
rect(10, 10, 5, 2, c.cloud);
rect(44, 16, 12, 3, c.cloud);
rect(47, 14, 6, 2, c.cloud);
// Meadow behind the table, a darker crest.
rect(0, 30, GRID, 10, c.snow);
rect(0, 30, GRID, 1, c.snowShade);
// Two low snowy hills, stepped like pixel art.
for (const [x, w] of [[2, 20], [36, 24]]) {
  rect(x, 28, w, 2, c.snow);
  rect(x + 3, 26, w - 6, 2, c.snow);
  rect(x + 3, 25, w - 6, 1, c.snowShade);
  rect(x, 27, 3, 1, c.snowShade);
  rect(x + w - 3, 27, 3, 1, c.snowShade);
}
// Plank table: boards with seams, a light top edge, grain.
rect(0, 40, GRID, 24, c.plank);
rect(0, 40, GRID, 1, c.woodLight);
for (const y of [47, 55]) rect(0, y, GRID, 1, c.woodDark);
for (const [x, y, w] of [[5, 43, 9], [30, 44, 12], [50, 42, 8], [14, 50, 10], [40, 51, 14], [3, 58, 12], [26, 59, 9], [48, 60, 11]]) rect(x, y, w, 1, c.wood);
// Bunting: a string with pennants in wheat, holly and berry.
rect(0, 1, GRID, 1, c.woodDark);
[c.wheat, c.holly, c.berry].forEach((colour, k) => {
  for (let x = k * 8; x < GRID; x += 24) {
    rect(x + 1, 2, 5, 1, colour);
    rect(x + 2, 3, 3, 1, colour);
    rect(x + 3, 4, 1, 1, colour);
  }
});

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

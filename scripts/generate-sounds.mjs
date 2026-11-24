// Synthesizes the two sounds of spec 10.1 from plain math, so their origin is this file (MIT).
// Deterministic: running it again writes byte-identical files. Usage: node scripts/generate-sounds.mjs
import { mkdirSync, writeFileSync } from "node:fs";

const RATE = 22050; // mono, 16 bit: small files, enough for a rattle and a chime
const out = new URL("../src/web/public/sounds/", import.meta.url);

// Seeded PRNG (mulberry32): same seed, same sound.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Dice rattling on a table: a few knocks, each a short low sine plus filtered noise, getting quieter.
function roll() {
  const rand = random(6);
  const samples = new Float32Array(Math.round(RATE * 0.6));
  let t = 0.01;
  for (let k = 0; k < 7; k++) {
    const start = Math.round(t * RATE);
    const gain = (1 - k / 9) * (0.6 + 0.4 * rand());
    const pitch = 170 + 160 * rand();
    let low = 0;
    for (let i = 0; start + i < samples.length && i < RATE * 0.08; i++) {
      const s = i / RATE;
      low += 0.35 * (rand() * 2 - 1 - low); // one-pole low-pass: a dull click, not a hiss
      samples[start + i] += gain * (0.7 * Math.sin(2 * Math.PI * pitch * s) * Math.exp(-s / 0.018) + low * Math.exp(-s / 0.006));
    }
    t += 0.045 + 0.06 * rand();
  }
  return samples;
}

// A six: a soft rising G major chime, clearly unlike the rattle.
function six() {
  const samples = new Float32Array(Math.round(RATE * 0.9));
  [784, 988, 1175].forEach((freq, n) => {
    const start = Math.round(n * 0.09 * RATE);
    for (let i = 0; start + i < samples.length; i++) {
      const s = i / RATE;
      const envelope = Math.min(1, s / 0.005) * Math.exp(-s / 0.28);
      const tone = Math.sin(2 * Math.PI * freq * s) + 0.25 * Math.sin(4 * Math.PI * freq * s) + 0.08 * Math.sin(6 * Math.PI * freq * s);
      samples[start + i] += envelope * tone;
    }
  });
  return samples;
}

// Quiet on purpose: everyone sits in the same voice channel.
function wav(samples, peak) {
  const max = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const fade = Math.round(RATE * 0.02); // no click at the end
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => {
    const tail = Math.min(1, (samples.length - i) / fade);
    data.writeInt16LE(Math.round((v / max) * peak * tail * 32767), i * 2);
  });
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16); // fmt chunk size
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28); // bytes per second
  head.writeUInt16LE(2, 32); // block align
  head.writeUInt16LE(16, 34); // bits per sample
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

mkdirSync(out, { recursive: true });
for (const [name, file] of [["roll.wav", wav(roll(), 0.4)], ["six.wav", wav(six(), 0.35)]]) {
  if (file.length > 60_000) throw new Error(`${name} is ${file.length} bytes, the limit is 60 KB`);
  writeFileSync(new URL(name, out), file);
  console.log(`${name}: ${file.length} bytes`);
}

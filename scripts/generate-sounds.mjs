// Synthesizes the six and the turn sound from plain math, so their origin is this file (MIT).
// Deterministic: running it again writes byte-identical files. Usage: node scripts/generate-sounds.mjs
// The roll sound is a recording (CC0), not synthesized: docs-tech/ui-assets.md says where it comes from.
import { mkdirSync, writeFileSync } from "node:fs";

const RATE = 22050; // mono, 16 bit: a small file, enough for a chime
const out = new URL("../src/web/public/sounds/", import.meta.url);

// A six: a little marimba arpeggio up G major (wood, like the dice), soft enough to hear 30 times.
// Bar partials at 1× and 3.9× the note; no higher ones, which would alias at 22.05 kHz.
function six() {
  const samples = new Float32Array(Math.round(RATE * 0.8));
  [784, 988, 1175, 1568].forEach((freq, n) => {
    const start = Math.round(n * 0.075 * RATE);
    const decay = n === 3 ? 0.26 : 0.18;
    for (let i = 0; start + i < samples.length; i++) {
      const s = i / RATE;
      const mallet = 1 - Math.exp(-s / 0.0012); // soft attack: no click
      const tone = Math.sin(2 * Math.PI * freq * s) * Math.exp(-s / decay) + 0.3 * Math.sin(2 * Math.PI * 3.9 * freq * s) * Math.exp(-s / 0.03);
      samples[start + i] += (0.75 + 0.1 * n) * mallet * tone;
    }
  });
  return samples;
}

// Your turn: two small glockenspiel strikes, A5 then E6, a hint rather than a fanfare (the six has
// that). Bar partials 1×, 2.76× and 5.4×, all below 11 kHz.
function turn() {
  const samples = new Float32Array(Math.round(RATE * 0.7));
  [880, 1319].forEach((freq, n) => {
    const start = Math.round(n * 0.12 * RATE);
    for (let i = 0; start + i < samples.length; i++) {
      const s = i / RATE;
      const mallet = 1 - Math.exp(-s / 0.0008);
      const tone =
        Math.sin(2 * Math.PI * freq * s) * Math.exp(-s / 0.22) +
        0.35 * Math.sin(2 * Math.PI * 2.76 * freq * s) * Math.exp(-s / 0.06) +
        0.12 * Math.sin(2 * Math.PI * 5.4 * freq * s) * Math.exp(-s / 0.025);
      samples[start + i] += mallet * tone;
    }
  });
  return samples;
}

// Quiet on purpose: everyone sits in the same voice channel.
function wav(samples, peak) {
  const max = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const fade = Math.round(RATE * 0.05); // a gentle end, no click
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
for (const [name, file] of [["six.wav", wav(six(), 0.35)], ["turn.wav", wav(turn(), 0.3)]]) {
  if (file.length > 60_000) throw new Error(`${name} is ${file.length} bytes, the limit is 60 KB`);
  writeFileSync(new URL(name, out), file);
  console.log(`${name}: ${file.length} bytes`);
}

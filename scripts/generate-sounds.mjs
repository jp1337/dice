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

// One impact, by modal synthesis: a contact pulse (half sine, a little rough) rings a few damped
// resonators. A shorter contact (a harder hit) excites the high modes more, as with real dice.
function strike(samples, at, velocity, contactMs, modes, rand) {
  const start = Math.round(at * RATE);
  const width = Math.max(2, Math.round((contactMs / 1000) * RATE));
  const pulse = Array.from({ length: width }, (_, i) => Math.sin((Math.PI * (i + 0.5)) / width) * (1 + 0.4 * (rand() * 2 - 1)));
  const area = pulse.reduce((sum, v) => sum + v, 0);
  for (const [freq, decay, gain] of modes) {
    const w = (2 * Math.PI * freq) / RATE;
    const r = Math.exp(-1 / (decay * RATE));
    const scale = (velocity * gain * Math.sin(w)) / area; // impulse response: a sine of amplitude gain
    let y1 = 0, y2 = 0;
    for (let i = 0; start + i < samples.length && i < decay * RATE * 7; i++) {
      const y = 2 * r * Math.cos(w) * y1 - r * r * y2 + (i < width ? pulse[i] * scale : 0);
      samples[start + i] += y;
      y2 = y1;
      y1 = y;
    }
  }
}

// Two small resin dice: shaken in the hand, thrown onto a wooden table, bouncing with shrinking gaps,
// knocking into each other, then rocking to rest. Fills ROLL_ANIMATION_MS (src/web/lib/ui.ts).
function roll() {
  const rand = random(6);
  const samples = new Float32Array(Math.round(RATE * 1.3));
  const jitter = (v, spread) => v * (1 + spread * (rand() * 2 - 1));
  const dice = [[2650, 4100, 5600], [2950, 4500, 6150]]; // each die rings at its own pitches
  const click = (die, soft) => dice[die].map((f, m) => [jitter(f, 0.05), jitter(0.012 - 0.0025 * m, 0.3) * soft, 0.4 + 0.6 * rand()]);
  const wood = (v) => [[jitter(170, 0.1), 0.03, 0.35 * v], [jitter(280, 0.1), 0.02, 0.25 * v], [jitter(1050, 0.15), 0.006, 0.25 * v]];
  const hit = (t, die, v, table) => strike(samples, t, v, 0.18 * v ** -0.2, [...click(die, 1), ...(table ? wood(v) : [])], rand);

  // In the hand: quieter, damped by the fingers (shorter ringing), no table.
  for (let t = 0.01; t < 0.27; t += jitter(0.034, 0.4)) strike(samples, t, jitter(0.4, 0.35), 0.25, click(rand() < 0.5 ? 0 : 1, 0.7), rand);

  for (const die of [0, 1]) {
    let t = 0.33 + die * jitter(0.04, 0.3), v = 1 - die * 0.15, gap = jitter(0.15, 0.15);
    while (v > 0.1) {
      hit(t, die, v, true);
      if (rand() < 0.5) hit(t + jitter(0.009, 0.4), die, v * 0.45, true); // an edge lands, then the face
      t += gap * (0.75 + 0.5 * rand()); // irregular: the die tumbles, not a ball
      gap *= 0.78;
      v *= jitter(0.72, 0.08);
    }
    for (let k = 0, dt = 0.02; k < 3; k++, dt *= 0.7) hit((t += dt), die, v * 0.6 ** k, true); // rocking to rest
  }
  for (const t of [0.47, 0.62, 0.71]) strike(samples, jitter(t, 0.04), jitter(0.4, 0.3), 0.2, [...click(0, 1), ...click(1, 1)], rand); // die on die
  hit(1.08, 1, 0.15, true); // the last die tips onto its face
  return samples;
}

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
for (const [name, file] of [["roll.wav", wav(roll(), 0.35)], ["six.wav", wav(six(), 0.35)]]) {
  if (file.length > 60_000) throw new Error(`${name} is ${file.length} bytes, the limit is 60 KB`);
  writeFileSync(new URL(name, out), file);
  console.log(`${name}: ${file.length} bytes`);
}

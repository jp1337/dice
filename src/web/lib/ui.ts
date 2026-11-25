// Pure logic behind the UI components, tested in test/web.test.ts. Components stay thin.
import { REACTION_INTERVAL_MS, ROLL_ANIMATION_MS, type reactionEmojis } from "../../shared/constants.js";

export type ReactionEmoji = (typeof reactionEmojis)[number];

// The same for every client and shorter than the server's roll cooldown (ROLL_COOLDOWN_MS), so the
// next roll never starts while a die still tumbles. style.css holds the same value as --roll-duration.
export { ROLL_ANIMATION_MS };
export const FLOAT_MS = 2400; // style.css: --float-duration

// Spec 4.4 R6: the host's six text. Plain string out, rendered as text by React, so a name like
// "<b>x</b>" stays literal. One pass: a name containing "{platz}" is not substituted again.
export function fillTemplate(template: string, values: { name: string; platz: number }) {
  return template.replace(/\{(name|platz)\}/g, (_, key: "name" | "platz") => String(values[key]));
}

export const rollText = (values: readonly number[]) => `Gewürfelt: ${values.join(" und ")}`;

// Pip centres per face on a 100×100 die.
const L = 27, M = 50, R = 73;
export const PIPS: Record<number, [number, number][]> = {
  1: [[M, M]],
  2: [[L, L], [R, R]],
  3: [[L, L], [M, M], [R, R]],
  4: [[L, L], [R, L], [L, R], [R, R]],
  5: [[L, L], [R, L], [M, M], [L, R], [R, R]],
  6: [[L, L], [R, L], [L, M], [R, M], [L, R], [R, R]],
};

// Milliseconds until the next reaction is allowed; mirrors the server's limit (spec 4.11).
export function cooldownLeft(lastSentAt: number | null, now: number, interval = REACTION_INTERVAL_MS) {
  return lastSentAt === null ? 0 : Math.max(0, lastSentAt + interval - now);
}

export const reactionLabels: Record<ReactionEmoji, string> = {
  "🎉": "Feiern",
  "😮": "Staunen",
  "😂": "Lachen",
  "👏": "Applaus",
  "🍀": "Glück",
  "❤️": "Herz",
};

export type FloatingEmoji = { id: number; emoji: ReactionEmoji; lane: number; delay: number };
export const FLOAT_LANES = 6; // classes .lane-0 … .lane-5 in Reactions.css
const PER_EMOJI = 4;
const PER_BURST = 12;

// A server batch {emoji, count} becomes a few floating emojis. Capped, so 100 clients cheering at
// once stay readable; lanes and delays spread them out.
export function expandBurst(emojis: readonly { emoji: ReactionEmoji; count: number }[], firstId: number): FloatingEmoji[] {
  const out: FloatingEmoji[] = [];
  for (const { emoji, count } of emojis) {
    for (let i = 0; i < Math.min(count, PER_EMOJI) && out.length < PER_BURST; i++) {
      const id = firstId + out.length;
      out.push({ id, emoji, lane: id % FLOAT_LANES, delay: out.length % 4 });
    }
  }
  return out;
}

export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  // Array.from splits by code point, so an emoji or accented first letter stays whole.
  return words.map((word) => Array.from(word)[0]!.toUpperCase()).join("") || "?";
}

export const AVATAR_TONES = 8; // classes .tone-0 … .tone-7 in Avatar.css
// FNV-1a over the user id: the same person always gets the same colour, on every client.
export function avatarTone(userId: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) hash = Math.imul(hash ^ userId.charCodeAt(i), 0x01000193);
  return (hash >>> 0) % AVATAR_TONES;
}

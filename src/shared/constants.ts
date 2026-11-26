// Values shared by server and browser, without zod: the web bundle imports these from here, never
// from contracts.ts, which re-exports them (test/web.test.ts holds the boundary).

// Emoji reactions (spec 4.11)
export const reactionEmojis = ["🎉", "😮", "😂", "👏", "🍀", "❤️"] as const;

// Limits shared by server and client
export const MAX_CLIENT_MESSAGE_BYTES = 4096;
export const NICKNAME_MAX = 32;
export const MAX_SIMULATED_PLAYERS = 30; // per test room (spec 4.7)
// The dice tumble ROLL_ANIMATION_MS (style.css: --roll-duration); then everyone sees a countdown of
// NEXT_ROLL_COUNTDOWN_MS before the next roll, so the result can sink in. The server refuses rolls
// for the sum after one.
export const ROLL_ANIMATION_MS = 1300;
export const NEXT_ROLL_COUNTDOWN_MS = 5000;
export const ROLL_COOLDOWN_MS = ROLL_ANIMATION_MS + NEXT_ROLL_COUNTDOWN_MS;
export const REACTION_INTERVAL_MS = 500; // per person; short on purpose: reactions are for spamming
// The client waits REACTION_INTERVAL_MS between sends; arrival gaps shrink with network jitter, so the server
// lets a reaction through this much early instead of answering a steady spammer with error notices.
export const REACTION_SLACK_MS = 150;
export const PING_INTERVAL_MS = 25_000;
export const ROOM_NAME_MAX = 60;
export const SIX_MESSAGE_MAX = 200;

// Free text other people see (contracts.ts visibleText): the browser checks the same rule before sending.
export const INVISIBLE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u115F\u1160\u2800\u3164\uFFA0]|(?! )\p{Z}|\p{M}{3}/u;
export const VISIBLE_CHAR = /[\p{L}\p{N}\p{S}\p{P}]/u;
// The one format character allowed: a zero width joiner inside an emoji sequence (family, rainbow flag),
// between two pictographs; the first may carry a variation selector or a skin tone.
export const EMOJI_JOINER = /(?<=\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]?)\u200D(?=\p{Extended_Pictographic})/gu;
export const isVisibleText = (text: string) => !INVISIBLE_TEXT.test(text.replace(EMOJI_JOINER, "")) && VISIBLE_CHAR.test(text);

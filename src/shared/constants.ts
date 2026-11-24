// Values shared by server and browser, without zod: the web bundle imports these from here, never
// from contracts.ts, which re-exports them (test/web.test.ts holds the boundary).

// Emoji reactions (spec 4.11)
export const reactionEmojis = ["🎉", "😮", "😂", "👏", "🍀", "❤️"] as const;

// Limits shared by server and client
export const MAX_CLIENT_MESSAGE_BYTES = 4096;
export const NICKNAME_MAX = 32;
export const ROLL_COOLDOWN_MS = 2000;
export const REACTION_INTERVAL_MS = 2000;
export const PING_INTERVAL_MS = 25_000;
export const ROOM_NAME_MAX = 60;

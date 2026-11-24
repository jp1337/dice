// Discord OAuth2 and avatar download (spec 5, 5.1). Tokens live only inside exchangeAndCheck.
// Docs checked 2026-11-24:
//   OAuth2 code grant, token exchange: https://docs.discord.com/developers/topics/oauth2
//   User object, GET /users/@me, GET /users/@me/guilds/{guild.id}/member: https://docs.discord.com/developers/resources/user
//   Guild member object (nick, avatar): https://docs.discord.com/developers/resources/guild
//   API base and version, CDN paths, ?size, a_ prefix of animated hashes: https://docs.discord.com/developers/reference
import { z } from "zod";
import type { Config } from "./config.js";

export const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
export const SCOPES = "identify guilds.members.read";
const API_TIMEOUT_MS = 10_000;
export const AVATAR_TIMEOUT_MS = 5000;
export const AVATAR_MAX_BYTES = 1024 * 1024;

const discordUser = z.object({
  id: z.string().regex(/^\d{17,20}$/),
  username: z.string().min(1),
  global_name: z.string().nullish(),
  avatar: z.string().nullish(),
});
const guildMember = z.object({ nick: z.string().nullish(), avatar: z.string().nullish() });

export type DiscordProfile = {
  discordId: string;
  username: string;
  displayName: string; // guild nick > global name > username (spec 5)
  avatarHash: string | null; // guild avatar first, else user avatar (spec 5.1)
  avatarPath: string | null; // CDN path for avatarHash
};

// status: what the callback answers; reason: what the log says. Never carries a token.
export class LoginError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

async function call(url: string, init: RequestInit, step: string) {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  } catch {
    throw new LoginError(502, `${step}: no response`);
  }
  return res;
}

export async function exchangeAndCheck(config: Config, code: string, redirectUri: string): Promise<DiscordProfile> {
  const api = `${config.discordApiBase}/v10`;
  const tokenRes = await call(
    `${api}/oauth2/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: config.discordClientId,
        client_secret: config.discordClientSecret,
      }),
    },
    "token",
  );
  // 400 = invalid or reused code (e.g. the callback URL opened twice); everything else is Discord's side.
  if (!tokenRes.ok) throw new LoginError(tokenRes.status === 400 ? 400 : 502, `token: HTTP ${tokenRes.status}`);
  const token = z.object({ access_token: z.string().min(1) }).safeParse(await tokenRes.json().catch(() => null));
  if (!token.success) throw new LoginError(502, "token: malformed response");
  const headers = { Authorization: `Bearer ${token.data.access_token}` };

  const userRes = await call(`${api}/users/@me`, { headers }, "user");
  if (!userRes.ok) throw new LoginError(502, `user: HTTP ${userRes.status}`);
  const user = discordUser.safeParse(await userRes.json().catch(() => null));
  if (!user.success) throw new LoginError(502, "user: malformed response");

  const memberRes = await call(`${api}/users/@me/guilds/${config.discordGuildId}/member`, { headers }, "member");
  // 404 Unknown Guild/Member, 403 no access: the user is not on the server.
  if (memberRes.status === 404 || memberRes.status === 403) throw new LoginError(403, "not a guild member");
  if (!memberRes.ok) throw new LoginError(502, `member: HTTP ${memberRes.status}`);
  const member = guildMember.safeParse(await memberRes.json().catch(() => null));
  if (!member.success) throw new LoginError(502, "member: malformed response");
  // The access token goes out of scope here; it is never stored or logged.

  const u = user.data;
  const m = member.data;
  const avatarHash = m.avatar ?? u.avatar ?? null;
  return {
    discordId: u.id,
    username: u.username,
    displayName: m.nick || u.global_name || u.username,
    avatarHash,
    avatarPath: m.avatar
      ? `guilds/${config.discordGuildId}/users/${u.id}/avatars/${m.avatar}`
      : u.avatar
        ? `avatars/${u.id}/${u.avatar}`
        : null,
  };
}

const IMAGE_TYPES: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  "image/gif": (b) => ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1")),
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};

// Discord avatar hashes: 32 hex digits, "a_" in front if animated.
const AVATAR_HASH = /^(a_)?[0-9a-f]{32}$/;

// Downloads a 128 px static PNG (also for animated hashes). Throws on anything unexpected;
// the caller keeps the old image then. The URL is built here from IDs and hash only.
export async function downloadAvatar(cdnBase: string, path: string, hash: string) {
  if (!AVATAR_HASH.test(hash)) throw new Error("unexpected avatar hash");
  const url = new URL(`${cdnBase}/${path}.png?size=128`);
  // Belt and braces: config only allows another CDN base under NODE_ENV=test.
  if (url.origin !== new URL(cdnBase).origin) throw new Error("foreign avatar host");
  // redirect "error": a redirect could lead to any host.
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`avatar: HTTP ${res.status}`);
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const matches = IMAGE_TYPES[contentType];
  if (!matches) throw new Error(`avatar: content type ${contentType}`);
  if (Number(res.headers.get("content-length") ?? 0) > AVATAR_MAX_BYTES) throw new Error("avatar: too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > AVATAR_MAX_BYTES) {
      await res.body.cancel().catch(() => {});
      throw new Error("avatar: too large");
    }
    chunks.push(Buffer.from(chunk));
  }
  const image = Buffer.concat(chunks);
  if (!matches(image)) throw new Error("avatar: content does not match its type");
  return { image, contentType };
}

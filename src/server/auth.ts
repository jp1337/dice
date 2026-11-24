// Login, sessions, /api/me and avatars (spec 5, 5.1, 7).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { MeResponse } from "../shared/contracts.js";
import type { Config } from "./config.js";
import { sessions, users } from "./db/schema.js";
import { AUTHORIZE_URL, type DiscordProfile, LoginError, SCOPES, downloadAvatar, exchangeAndCheck } from "./discord.js";

export const SESSION_COOKIE = "dice_session";
export const STATE_COOKIE = "dice_login";
export const SESSION_DAYS = 7;
export const STATE_MAX_AGE_S = 600;
export const LOGIN_LIMIT_PER_MINUTE = 10;

declare module "fastify" {
  interface FastifyRequest {
    user: { id: string; discordId: string } | null;
  }
}

const HTML = "text/html; charset=utf-8";
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Own relative paths only. Printable ASCII without spaces, since browsers drop tabs and newlines
// ("/\t/evil" would become "//evil"); no "//" or "\" (both can mean another host).
export function safeNext(next: unknown) {
  return typeof next === "string" && next.length <= 512 && /^\/[\x21-\x7e]*$/.test(next) && !next.startsWith("//") && !next.includes("\\")
    ? next
    : "/";
}

function errorPage(title: string, text: string, retry: string) {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex">
<meta name="color-scheme" content="light dark">
<title>${title} – Würfel</title>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${text}</p>
<p><a href="${escapeHtml(retry)}">Erneut anmelden</a></p>
</main>
<footer>
<nav><a href="/">Start</a> · <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a></nav>
</footer>
</body>
</html>
`;
}

const messages: Record<number, [string, string]> = {
  400: [
    "Anmeldung abgebrochen",
    "Die Anmeldung konnte nicht abgeschlossen werden. Das passiert zum Beispiel, wenn die Discord-App den Link in einem anderen Browser geöffnet hat oder die Anmeldung zu lange gedauert hat. Bitte versuche es noch einmal.",
  ],
  401: ["Anmeldung abgebrochen", "Du hast die Anmeldung bei Discord abgelehnt. Ohne Anmeldung kannst du nicht mitwürfeln."],
  403: [
    "Kein Zugang",
    "Dein Discord-Konto ist nicht Mitglied des Discord-Servers, für den dieses Würfel-Tool gedacht ist. Melde dich mit dem Konto an, mit dem du auf dem Server bist.",
  ],
  502: ["Discord antwortet nicht", "Discord hat gerade nicht richtig geantwortet. Bitte versuche es in einer Minute noch einmal."],
};

export async function registerAuth(app: FastifyInstance, config: Config, db: NodePgDatabase) {
  // Separate keys for separate purposes, both derived from SESSION_SECRET.
  const sessionKey = createHmac("sha256", config.sessionSecret).update("session-id").digest();
  const sessionId = (token: string) => createHmac("sha256", sessionKey).update(token).digest("hex");
  const redirectUri = new URL("/auth/callback", config.baseUrl).href;
  const cookieBase = { httpOnly: true, secure: true, sameSite: "lax" } as const;
  const loginLimit = { rateLimit: { max: LOGIN_LIMIT_PER_MINUTE, timeWindow: "1 minute" } };

  app.decorateRequest("user", null);

  // preHandler for routes that need a user: resolves the session cookie, 401 without one.
  async function requireUser(request: FastifyRequest, reply: FastifyReply) {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      const [row] = await db
        .select({ id: users.id, discordId: users.discordId })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.id, sessionId(token)), gt(sessions.expiresAt, new Date())));
      if (row?.discordId) request.user = { id: row.id, discordId: row.discordId };
    }
    if (!request.user) return reply.code(401).send({ error: "unauthorized" });
  }

  app.get<{ Querystring: { next?: string } }>("/auth/login", { config: loginLimit }, (request, reply) => {
    const state = randomBytes(32).toString("base64url");
    // The target survives the round trip in the signed cookie, never in the URL sent to Discord.
    reply.setCookie(STATE_COOKIE, `${state}:${safeNext(request.query.next)}`, {
      ...cookieBase,
      path: "/auth",
      maxAge: STATE_MAX_AGE_S,
      signed: true,
    });
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: config.discordClientId,
      scope: SCOPES,
      state,
      redirect_uri: redirectUri,
    }).toString();
    return reply.redirect(url.href);
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/auth/callback", { config: loginLimit }, async (request, reply) => {
    const raw = request.cookies[STATE_COOKIE];
    const unsigned = raw ? request.unsignCookie(raw) : null;
    const stored = unsigned?.valid ? (unsigned.value ?? "") : "";
    const sep = stored.indexOf(":");
    const expected = sep > 0 ? stored.slice(0, sep) : "";
    const next = safeNext(sep > 0 ? stored.slice(sep + 1) : "/");
    const retry = next === "/" ? "/auth/login" : `/auth/login?next=${encodeURIComponent(next)}`;
    reply.clearCookie(STATE_COOKIE, { ...cookieBase, path: "/auth" });

    const fail = (status: number, reason: string) => {
      if (status === 403) request.log.warn({ ip: request.ip }, "login rejected: not a guild member");
      else request.log.warn({ ip: request.ip, reason }, "login failed");
      const [title, text] = messages[status] ?? messages[502]!;
      return reply.code(status).type(HTML).send(errorPage(title, text, retry));
    };

    const { code, state, error } = request.query;
    if (error) return fail(error === "access_denied" ? 401 : 400, `discord: ${error === "access_denied" ? error : "error"}`);
    if (!expected) return fail(400, "state cookie missing or invalid");
    if (!state || state.length !== expected.length || !timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
      return fail(400, "state mismatch");
    }
    if (!code) return fail(400, "code missing");

    let profile: DiscordProfile;
    try {
      profile = await exchangeAndCheck(config, code, redirectUri);
    } catch (err) {
      if (err instanceof LoginError) return fail(err.status, err.reason);
      return fail(502, "unexpected error");
    }

    // Only members get here, so a rejected login leaves no row behind.
    const [user] = await db
      .insert(users)
      .values({ discordId: profile.discordId, username: profile.username, displayName: profile.displayName, lastLoginAt: new Date() })
      .onConflictDoUpdate({
        target: users.discordId,
        set: { username: profile.username, displayName: profile.displayName, lastLoginAt: new Date() },
      })
      .returning({ id: users.id, avatarHash: users.avatarHash });
    request.user = { id: user!.id, discordId: profile.discordId };

    // Avatar only on change (spec 5.1); a failed download keeps the old image and never fails the login.
    if (profile.avatarHash !== user!.avatarHash) {
      try {
        const avatar = profile.avatarHash && profile.avatarPath ? await downloadAvatar(config.discordCdnBase, profile.avatarPath, profile.avatarHash) : null;
        await db
          .update(users)
          .set({ avatarHash: avatar ? profile.avatarHash : null, avatarImage: avatar?.image ?? null, avatarContentType: avatar?.contentType ?? null })
          .where(eq(users.id, user!.id));
      } catch (err) {
        request.log.warn({ reason: (err as Error).message }, "avatar download failed");
      }
    }

    const token = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({ id: sessionId(token), userId: user!.id, expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) });
    reply.setCookie(SESSION_COOKIE, token, { ...cookieBase, path: "/", maxAge: SESSION_DAYS * 86_400 });
    return reply.redirect(next);
  });

  app.post("/auth/logout", async (request, reply) => {
    // CSRF: only the app itself may log someone out. Browsers send Origin on every POST.
    if (request.headers.origin !== config.baseUrl.origin) return reply.code(403).send({ error: "forbidden" });
    const token = request.cookies[SESSION_COOKIE];
    if (token) await db.delete(sessions).where(eq(sessions.id, sessionId(token)));
    reply.clearCookie(SESSION_COOKIE, { ...cookieBase, path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/me", { preHandler: requireUser }, async (request) => {
    const [row] = await db
      .select({ displayName: users.displayName, nickname: users.nickname, avatarHash: users.avatarHash })
      .from(users)
      .where(eq(users.id, request.user!.id));
    const me: MeResponse = {
      userId: request.user!.id,
      displayName: row!.nickname ?? row!.displayName,
      avatarUrl: row!.avatarHash ? `/avatars/${request.user!.id}/${row!.avatarHash}` : null,
      isHost: config.hostDiscordIds.includes(request.user!.discordId), // never stored (spec 4.2)
    };
    return me;
  });

  app.get<{ Params: { userId: string; hash: string } }>("/avatars/:userId/:hash", { preHandler: requireUser }, async (request, reply) => {
    const { userId, hash } = request.params;
    if (!/^[0-9a-f-]{36}$/.test(userId)) return reply.code(404).send({ error: "not_found" });
    const [row] = await db
      .select({ hash: users.avatarHash, image: users.avatarImage, type: users.avatarContentType })
      .from(users)
      .where(eq(users.id, userId));
    if (!row?.image || !row.type || row.hash !== hash) return reply.code(404).send({ error: "not_found" });
    return reply.type(row.type).send(row.image);
  });
}

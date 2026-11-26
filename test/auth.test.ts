import { randomInt } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/server/db/migrate.js";
import { LOGIN_LIMIT_PER_MINUTE, SESSION_COOKIE, STATE_COOKIE, safeNext } from "../src/server/auth.js";
import { ACCESS_TOKEN, PNG, startFakeDiscord } from "./fake-discord.js";
import { baseEnv, makeApp } from "./helpers.js";

const dbUrl = process.env.TEST_DATABASE_URL;
const ORIGIN = "https://dice.example.org";
const HOST_ID = "100000000000000002";
const hash = (c: string) => c.repeat(32);

type App = Awaited<ReturnType<typeof makeApp>>["app"];

// Each login comes from its own address, so the login rate limit never interferes.
let ip = 0;
const nextIp = () => `10.1.${(++ip >> 8) & 255}.${ip & 255}`;
const newDiscordId = () => `1${String(randomInt(2 ** 47)).padStart(17, "0")}`;

async function startLogin(app: App, next?: string) {
  const res = await app.inject({ url: next === undefined ? "/auth/login" : `/auth/login?next=${encodeURIComponent(next)}`, remoteAddress: nextIp() });
  const state = new URL(res.headers.location as string).searchParams.get("state")!;
  const cookie = res.cookies.find((c) => c.name === STATE_COOKIE)!;
  return { res, state, cookie };
}

async function login(app: App, next?: string) {
  const { state, cookie } = await startLogin(app, next);
  const res = await app.inject({
    url: `/auth/callback?code=fake-code&state=${state}`,
    cookies: { [STATE_COOKIE]: cookie.value },
    remoteAddress: nextIp(),
  });
  const session = res.cookies.find((c) => c.name === SESSION_COOKIE);
  return { res, session, token: session?.value };
}

const me = (app: App, token?: string) => app.inject({ url: "/api/me", cookies: token ? { [SESSION_COOKIE]: token } : {} });

describe("next (target after login)", () => {
  it.each(["/", "/r/abc", "/r/abc?x=1", "/a/b%2F%2Fc"])("keeps %s", (next) => expect(safeNext(next)).toBe(next));
  it.each(["//evil.example", "/\\evil.example", "https://evil.example", "evil", "/\t/evil.example", "/ x", "", undefined, ["/a"]])(
    "replaces %j with /",
    (next) => expect(safeNext(next)).toBe("/"),
  );
});

describe("without a database", () => {
  let app: App;
  // Nothing here may ever reach the real Discord.
  beforeAll(async () => ({ app } = await makeApp({ DISCORD_API_BASE: "http://127.0.0.1:1" })));
  afterAll(() => app.close());

  it("redirects to Discord with state, scopes and redirect URI, and sets a short-lived state cookie", async () => {
    const { res, state, cookie } = await startLogin(app, "/r/abc");
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: baseEnv.DISCORD_CLIENT_ID,
      scope: "identify guilds.members.read",
      state,
      redirect_uri: `${ORIGIN}/auth/callback`,
    });
    expect(state).toMatch(/^[\w-]{43}$/);
    expect(url.href).not.toContain("r%2Fabc"); // the target stays in the cookie
    expect(cookie).toMatchObject({ path: "/auth", maxAge: 600, httpOnly: true, secure: true, sameSite: "Lax" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  // "?state=a&state=b" made state an array, and hashing it threw: a 500 in JSON instead of the error page.
  it("rejects a repeated state parameter with the error page", async () => {
    const { state, cookie } = await startLogin(app);
    const res = await app.inject({ url: `/auth/callback?code=c&state=${state}&state=${state}`, cookies: { [STATE_COOKIE]: cookie.value } });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("rejects a callback without the state cookie (e.g. opened in another browser)", async () => {
    const res = await app.inject({ url: "/auth/callback?code=c&state=s" });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain('href="/auth/login"');
    expect(res.body).toContain("Erneut anmelden");
    expect(res.cookies.some((c) => c.name === SESSION_COOKIE)).toBe(false);
  });

  it("rejects a state mismatch and a tampered state cookie", async () => {
    const { state, cookie } = await startLogin(app, "/r/abc");
    const wrong = await app.inject({ url: `/auth/callback?code=c&state=${state.slice(1)}x`, cookies: { [STATE_COOKIE]: cookie.value } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toContain('href="/auth/login?next=%2Fr%2Fabc"');
    const forged = `${state}://evil.example.${cookie.value.split(".").pop()}`;
    const tampered = await app.inject({ url: `/auth/callback?code=c&state=${state}`, cookies: { [STATE_COOKIE]: forged } });
    expect(tampered.statusCode).toBe(400);
    for (const res of [wrong, tampered]) expect(res.cookies.some((c) => c.name === SESSION_COOKIE)).toBe(false);
  });

  it("rejects a non-ASCII state of the same UTF-16 length with 400, not 500", async () => {
    const { cookie } = await startLogin(app);
    const state = encodeURIComponent("é".repeat(43));
    const res = await app.inject({ url: `/auth/callback?code=c&state=${state}`, cookies: { [STATE_COOKIE]: cookie.value } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a validly signed state older than 10 minutes", async () => {
    const { state } = await startLogin(app);
    const old = app.signCookie(`${state}:${Date.now() - 601_000}:/`);
    const res = await app.inject({ url: `/auth/callback?code=c&state=${state}`, cookies: { [STATE_COOKIE]: old } });
    expect(res.statusCode).toBe(400);
    const future = app.signCookie(`${state}:${Date.now() + 120_000}:/`);
    expect((await app.inject({ url: `/auth/callback?code=c&state=${state}`, cookies: { [STATE_COOKIE]: future } })).statusCode).toBe(400);
  });

  it("uses a __Host- session cookie", () => {
    expect(SESSION_COOKIE).toBe("__Host-dice_session");
  });

  it("handles a declined consent (error=access_denied)", async () => {
    const { state, cookie } = await startLogin(app);
    const res = await app.inject({ url: `/auth/callback?error=access_denied&state=${state}`, cookies: { [STATE_COOKIE]: cookie.value } });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain("abgelehnt");
    expect(res.body).toContain("Erneut anmelden");
  });

  it("answers /api/me and /avatars with 401 without a session", async () => {
    const res = await me(app);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
    const avatar = await app.inject({ url: `/avatars/00000000-0000-0000-0000-000000000000/${hash("a")}` });
    expect(avatar.statusCode).toBe(401);
    expect(avatar.headers["cache-control"]).toBe("no-store");
  });

  it("only logs out on a same-origin POST", async () => {
    expect((await app.inject({ url: "/auth/logout" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/auth/logout" })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/auth/logout", headers: { origin: "https://evil.example" } })).statusCode).toBe(403);
  });

  it("limits /auth/login per IP and keeps the security headers on 429", async () => {
    for (let i = 0; i < LOGIN_LIMIT_PER_MINUTE; i++) {
      expect((await app.inject({ url: "/auth/login", remoteAddress: "192.0.2.50" })).statusCode).toBe(302);
    }
    const res = await app.inject({ url: "/auth/login", remoteAddress: "192.0.2.50" });
    expect(res.statusCode).toBe(429);
    expect(res.headers["x-robots-tag"]).toBeDefined();
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe.skipIf(!dbUrl)("login against a fake Discord", () => {
  let fake: Awaited<ReturnType<typeof startFakeDiscord>>;
  let app: App;
  let logs: Record<string, unknown>[];
  let pool: pg.Pool;
  let discordId: string;

  beforeAll(async () => {
    fake = await startFakeDiscord();
    ({ app, logs } = await makeApp({ DISCORD_API_BASE: fake.url, DISCORD_CDN_BASE: fake.url, HOST_DISCORD_IDS: HOST_ID }, dbUrl));
    pool = new pg.Pool({ connectionString: dbUrl });
    await runMigrations(pool);
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
    await fake.close();
  });
  beforeEach(() => {
    discordId = newDiscordId();
    fake.state = { user: { id: discordId, username: "erika", global_name: "Erika", avatar: null }, member: { nick: null, avatar: null }, avatar: {} };
    fake.avatarRequests.length = 0;
  });

  const userRow = async (id = discordId) =>
    (await pool.query("select * from users where discord_id = $1", [id])).rows[0] as Record<string, unknown> | undefined;

  it("logs a member in: session cookie, user row, /api/me", async () => {
    fake.state.member = { nick: "Erika vom Server", avatar: null };
    logs.length = 0;
    const { res, session, token } = await login(app, "/r/abc?x=1");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/r/abc?x=1");
    expect(session).toMatchObject({ path: "/", maxAge: 7 * 86400, httpOnly: true, secure: true, sameSite: "Lax" });
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(res.cookies.find((c) => c.name === STATE_COOKIE)?.maxAge).toBe(0); // cleared

    const row = await userRow();
    expect(row).toMatchObject({ username: "erika", display_name: "Erika vom Server", nickname: null, avatar_hash: null });
    expect(row?.last_login_at).toBeInstanceOf(Date);
    expect(Object.keys(row!)).not.toContain("email");
    // Only the hash of the token is stored.
    const { rows } = await pool.query("select id, expires_at from sessions where user_id = $1", [row!.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].id).not.toContain(token);
    expect(rows[0].expires_at.getTime() - Date.now()).toBeGreaterThan(7 * 86400_000 - 60_000);

    const body = await me(app, token);
    expect(body.statusCode).toBe(200);
    expect(body.headers["cache-control"]).toBe("no-store");
    expect(body.json()).toEqual({ userId: row!.id, displayName: "Erika vom Server", nickname: null, avatarUrl: null, isHost: false });

    const callbackLine = logs.find((l) => l.msg === "request" && l.path === "/auth/callback");
    expect(callbackLine?.userId).toBe(row!.id);
    expect(fake.tokenForms.at(-1)?.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
  });

  it("replaces the browser's previous session on a new login", async () => {
    const first = await login(app);
    const { state, cookie } = await startLogin(app);
    const again = await app.inject({
      url: `/auth/callback?code=fake-code&state=${state}`,
      cookies: { [STATE_COOKIE]: cookie.value, [SESSION_COOKIE]: first.token! },
      remoteAddress: nextIp(),
    });
    const second = again.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
    expect((await me(app, second)).statusCode).toBe(200);
    expect((await me(app, first.token)).statusCode).toBe(401);
  });

  it("uses global name, then username as display name and updates them on the next login", async () => {
    await login(app);
    expect((await userRow())?.display_name).toBe("Erika");
    fake.state.user = { ...fake.state.user, username: "erika2", global_name: null };
    await login(app);
    expect(await userRow()).toMatchObject({ username: "erika2", display_name: "erika2" });
  });

  it("rejects a non-member with 403, no session and no database row", async () => {
    fake.state.member = null;
    logs.length = 0;
    const { res, session } = await login(app);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("nicht Mitglied");
    expect(session).toBeUndefined();
    expect(await userRow()).toBeUndefined();
    expect(logs.find((l) => l.msg === "login rejected: not a guild member")?.ip).toBe("10.1.0.0"); // nextIp(), shortened
    fake.state.failStatus = { member: 403 };
    fake.state.member = { nick: null };
    expect((await login(app)).res.statusCode).toBe(403);
    expect(await userRow()).toBeUndefined();
  });

  it.each([
    ["Discord 500 on the token exchange", { token: 500 }, 502],
    ["an invalid code", { token: 400 }, 400],
    ["Discord 429 on the member check", { member: 429 }, 502],
    ["Discord 500 on /users/@me", { user: 500 }, 502],
  ])("fails cleanly on %s", async (_name, failStatus, status) => {
    fake.state.failStatus = failStatus;
    logs.length = 0;
    const { res, session } = await login(app);
    expect(res.statusCode).toBe(status);
    expect(res.body).toContain("Erneut anmelden");
    expect(res.body).not.toMatch(/at .*\.(ts|js):\d+/); // no stack trace
    expect(session).toBeUndefined();
    expect(logs.some((l) => l.msg === "login failed")).toBe(true);
  });

  it("fails cleanly when Discord is unreachable", async () => {
    const { app: offline } = await makeApp({ DISCORD_API_BASE: "http://127.0.0.1:1", DISCORD_CDN_BASE: fake.url }, dbUrl);
    const { res, session } = await login(offline);
    expect(res.statusCode).toBe(502);
    expect(session).toBeUndefined();
    await offline.close();
  });

  it("shows the error page and logs no personal data when the database fails during login", async () => {
    const readOnly = new URL(dbUrl!);
    readOnly.searchParams.set("options", "-c default_transaction_read_only=on");
    const { app: broken, logs: brokenLogs } = await makeApp({ DISCORD_API_BASE: fake.url, DISCORD_CDN_BASE: fake.url }, readOnly.href);
    fake.state.user = { ...fake.state.user, username: "uniqueusername7", global_name: "Unique Display Name" };
    const { res, session } = await login(broken);
    await broken.close();
    expect(res.statusCode).toBe(500);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("Erneut anmelden");
    expect(session).toBeUndefined();
    const text = JSON.stringify(brokenLogs);
    expect(text).toContain("25006"); // SQLSTATE read_only_sql_transaction
    for (const value of [discordId, "uniqueusername7", "Unique Display Name", "insert into"]) expect(text).not.toContain(value);
  });

  it("logs no image bytes or personal data when storing the avatar fails, and still logs in", async () => {
    await pool.query(`
      create or replace function dice_test_fail_avatar() returns trigger language plpgsql as $$
      begin if new.username = 'avatar-store-fails' then raise exception 'forced failure'; end if; return new; end $$;
      drop trigger if exists dice_test_fail_avatar on users;
      create trigger dice_test_fail_avatar before update of avatar_image on users for each row execute function dice_test_fail_avatar();`);
    fake.state.user = { ...fake.state.user, username: "avatar-store-fails", avatar: hash("f") };
    logs.length = 0;
    try {
      const { res, token } = await login(app);
      expect(res.statusCode).toBe(302);
      expect(await (await me(app, token)).json().avatarUrl).toBeNull();
    } finally {
      await pool.query("drop trigger dice_test_fail_avatar on users; drop function dice_test_fail_avatar();");
    }
    const failure = logs.find((l) => l.msg === "avatar could not be stored");
    expect(failure).toMatchObject({ err: { code: "P0001" } });
    const text = JSON.stringify(logs);
    for (const value of [discordId, "avatar-store-fails", "png-body", hash("f"), "update"]) expect(text).not.toContain(value);
  });

  it("rejects an expired session", async () => {
    const { token } = await login(app);
    expect((await me(app, token)).statusCode).toBe(200);
    await pool.query("update sessions set expires_at = now() - interval '1 second' where user_id = (select id from users where discord_id = $1)", [discordId]);
    expect((await me(app, token)).statusCode).toBe(401);
    expect((await me(app, "not-a-session")).statusCode).toBe(401);
  });

  it("logs out on a same-origin POST and deletes the session", async () => {
    const { token } = await login(app);
    const cookies = { [SESSION_COOKIE]: token! };
    expect((await app.inject({ method: "POST", url: "/auth/logout", cookies })).statusCode).toBe(403);
    expect((await me(app, token)).statusCode).toBe(200);
    const res = await app.inject({ method: "POST", url: "/auth/logout", cookies, headers: { origin: ORIGIN } });
    expect(res.statusCode).toBe(204);
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.maxAge).toBe(0);
    expect((await me(app, token)).statusCode).toBe(401);
  });

  it("marks hosts from HOST_DISCORD_IDS without storing it", async () => {
    fake.state.user = { ...fake.state.user, id: HOST_ID };
    const { token } = await login(app);
    expect((await me(app, token)).json().isHost).toBe(true);
  });

  it("sets no cookies but the session cookie and the login state cookie", async () => {
    fake.state.user.avatar = hash("1");
    const names = new Set<string>();
    const collect = (res: { cookies: { name: string }[] }) => res.cookies.forEach((c) => names.add(c.name));
    const { res: start } = await startLogin(app);
    collect(start);
    const { res, token } = await login(app);
    collect(res);
    const avatarUrl = (await me(app, token)).json().avatarUrl as string;
    for (const url of ["/", "/api/me", "/impressum", "/datenschutz", "/robots.txt", avatarUrl]) {
      collect(await app.inject({ url, cookies: { [SESSION_COOKIE]: token! } }));
    }
    collect(await app.inject({ method: "POST", url: "/auth/logout", cookies: { [SESSION_COOKIE]: token! }, headers: { origin: ORIGIN } }));
    expect([...names].sort()).toEqual([STATE_COOKIE, SESSION_COOKIE].sort());
  });

  it("never logs Discord tokens, codes, state or cookies", async () => {
    logs.length = 0;
    const { state } = await startLogin(app);
    const { token } = await login(app);
    fake.state.failStatus = { member: 500 };
    await login(app);
    const text = JSON.stringify(logs);
    for (const secret of [ACCESS_TOKEN, "fake-refresh", "fake-code", state, token!, baseEnv.DISCORD_CLIENT_SECRET, baseEnv.SESSION_SECRET]) {
      expect(text).not.toContain(secret);
    }
  });

  describe("avatars", () => {
    const avatarOf = async (token?: string) => (await me(app, token)).json().avatarUrl as string | null;

    it("downloads a new avatar as 128 px PNG and serves it with a session only", async () => {
      fake.state.user.avatar = hash("a");
      const { token } = await login(app);
      expect(fake.avatarRequests).toEqual([`/avatars/${discordId}/${hash("a")}.png?size=128`]);
      const url = await avatarOf(token);
      const { id } = (await userRow())!;
      expect(url).toBe(`/avatars/${id}/${hash("a")}`);

      const res = await app.inject({ url: url!, cookies: { [SESSION_COOKIE]: token! } });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(PNG)).toBe(true);
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");

      expect((await app.inject({ url: url! })).statusCode).toBe(401);
      const stale = await app.inject({ url: `/avatars/${id}/${hash("b")}`, cookies: { [SESSION_COOKIE]: token! } });
      expect(stale.statusCode).toBe(404);
      expect(stale.headers["cache-control"]).toBe("no-store");
      expect((await app.inject({ url: `/avatars/nope/${hash("a")}`, cookies: { [SESSION_COOKIE]: token! } })).statusCode).toBe(404);
      // 36 characters of hex and dashes, but no UUID: PostgreSQL refused it, and that was a 500.
      expect((await app.inject({ url: `/avatars/${"-".repeat(36)}/${hash("a")}`, cookies: { [SESSION_COOKIE]: token! } })).statusCode).toBe(404);
    });

    it("prefers the server avatar and fetches animated ones as static PNG", async () => {
      fake.state.user.avatar = hash("a");
      fake.state.member = { avatar: `a_${hash("c")}` };
      await login(app);
      expect(fake.avatarRequests).toEqual([`/guilds/${baseEnv.DISCORD_GUILD_ID}/users/${discordId}/avatars/a_${hash("c")}.png?size=128`]);
      expect((await userRow())?.avatar_hash).toBe(`a_${hash("c")}`);
    });

    it("does not download an unchanged avatar and replaces a changed one", async () => {
      fake.state.user.avatar = hash("a");
      await login(app);
      await login(app);
      expect(fake.avatarRequests).toHaveLength(1);
      fake.state.user.avatar = hash("b");
      fake.state.avatar = { type: "image/jpeg", body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]) };
      const { token } = await login(app);
      expect(fake.avatarRequests).toHaveLength(2);
      expect(await userRow()).toMatchObject({ avatar_hash: hash("b"), avatar_content_type: "image/jpeg" });
      expect(await avatarOf(token)).toMatch(new RegExp(`/${hash("b")}$`));
    });

    it("has no avatar URL without an avatar and downloads nothing", async () => {
      const { token } = await login(app);
      expect(fake.avatarRequests).toEqual([]);
      expect(await avatarOf(token)).toBeNull();
    });

    it.each([
      ["HTTP 500", { status: 500 }],
      ["a wrong content type", { type: "text/html" }],
      ["wrong magic bytes", { type: "image/png", body: Buffer.from("<svg onload=alert(1)>") }],
      ["more than 1 MB", { body: Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]) }],
      ["more than 1 MB without Content-Length", { body: Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]), chunked: true }],
      ["a redirect to a foreign host", { redirect: "foreign" }],
    ])("keeps the old image and still logs in on %s", async (_name, failure) => {
      fake.state.user.avatar = hash("a");
      await login(app);
      fake.state.user.avatar = hash("d");
      fake.state.avatar = failure;
      logs.length = 0;
      const { res, token } = await login(app);
      expect(res.statusCode).toBe(302);
      expect(fake.avatarRequests).toHaveLength(2);
      expect(await userRow()).toMatchObject({ avatar_hash: hash("a"), avatar_content_type: "image/png" });
      expect(await avatarOf(token)).toMatch(new RegExp(`/${hash("a")}$`));
      expect(logs.some((l) => l.msg === "avatar download failed")).toBe(true);
    });

    it("keeps the placeholder and still logs in on a timeout", { timeout: 15_000 }, async () => {
      fake.state.user.avatar = hash("e");
      fake.state.avatar = { delayMs: 6000 };
      const { res, token } = await login(app);
      expect(res.statusCode).toBe(302);
      expect(await avatarOf(token)).toBeNull();
    });

    it("refuses an avatar hash that is not a Discord hash", async () => {
      fake.state.user.avatar = "../../evil";
      const { res } = await login(app);
      expect(res.statusCode).toBe(302);
      expect(fake.avatarRequests).toEqual([]);
    });
  });
});

// HTTP application: security headers, logging, public pages and static files (spec 7, 8).
import { createHmac, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { STATUS_CODES } from "node:http";
import path from "node:path";
import type { Writable } from "node:stream";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest, LogController } from "fastify";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { registerAuth } from "./auth.js";
import type { Config } from "./config.js";
import { datenschutzHtml, escapeHtml, impressumHtml, notFoundHtml } from "./legal.js";
import { logIp } from "./log-ip.js";
import { MAX_CLIENT_MESSAGE_BYTES, PING_INTERVAL_MS, ROLL_COOLDOWN_MS } from "../shared/contracts.js";
import { SIMULATED_ROLL_DELAY_MS, registerRooms } from "./rooms.js";
import { robotsTxt } from "./robots.js";

export const HEALTHZ_LIMIT_PER_MINUTE = 120;
export const SHUTDOWN_GRACE_MS = 2000; // for WebSocket close handshakes; docker stops after 10 s

export type Deps = {
  pool: Pool;
  webRoot: string; // directory with the Vite build output
  logStream?: Writable; // defaults to stdout
  pingIntervalMs?: number; // WebSocket ping; defaults to PING_INTERVAL_MS, tests shorten it
  rollCooldownMs?: number; // defaults to ROLL_COOLDOWN_MS, tests shorten it
  simulatedRollDelayMs?: number; // defaults to SIMULATED_ROLL_DELAY_MS, tests shorten it
  randomInt?: (min: number, maxExclusive: number) => number; // dice and start order; defaults to crypto.randomInt, tests force values
};

// Paths that answer with the SPA's index.html. Every one gets the same HTML, so the link preview
// (spec 10.2) never depends on the room.
// Room slugs are base64url, 16 to 64 characters; anything else under /r/ is a 404.
export const SPA_ROUTES = ["/", "/r/:slug(^[A-Za-z0-9_-]{16,64}$)"];

const ROBOTS = "noindex, nofollow, noarchive, nosnippet, noimageindex";
const HTML = "text/html; charset=utf-8";
const TEXT = "text/plain; charset=utf-8";

type PgError = Error & { code: string; severity: string; constraint?: string; table?: string };
const isPgError = (e: unknown): e is PgError =>
  e instanceof Error && typeof (e as PgError).severity === "string" && typeof (e as PgError).code === "string";

// Database errors carry the SQL, its parameters (names, Discord IDs, avatar bytes) and row details in
// message, detail and stack. Only their SQLSTATE and the affected constraint and table are logged.
export function serializeError(err: Error & { query?: unknown; params?: unknown; code?: unknown }): Record<string, unknown> {
  const db = isPgError(err) ? err : isPgError(err.cause) ? err.cause : null;
  if (db || "query" in err || "params" in err) {
    return { type: err.constructor.name, code: db?.code, constraint: db?.constraint, table: db?.table };
  }
  return {
    type: err.constructor.name,
    message: err.message,
    stack: err.stack,
    ...(err.code !== undefined && { code: err.code }),
    ...(err.cause instanceof Error && { cause: serializeError(err.cause) }),
  };
}

// Without the query string, which may carry codes or tokens, and without the room slug: "/r/<slug>" in a
// log is the key to watch a public room. Logged as "/r/:slug", "/api/rooms/:slug" and "/ws/rooms/:slug".
const logPath = (url: string) => url.split("?")[0]!.replace(/^\/(r|api\/rooms|ws\/rooms)\/[^/]+/, "/$1/:slug");

function logRequest(request: FastifyRequest, reply: FastifyReply) {
  request.log.info(
    {
      ip: logIp(request.ip),
      method: request.method,
      path: logPath(request.url),
      status: reply.statusCode,
      userId: request.user?.id ?? null, // set by routes that resolve the session
      ms: Math.round(reply.elapsedTime),
    },
    "request",
  );
}

export async function buildApp(config: Config, deps: Deps) {
  // Sent on every response: by the onSend hook, and by clientErrorHandler for requests Fastify
  // could not parse. Cache-Control is overridden for hashed assets.
  const headers: Record<string, string> = {
    "X-Robots-Tag": ROBOTS,
    "Content-Security-Policy": [
      "default-src 'self'",
      `connect-src 'self' wss://${config.baseUrl.host}`,
      "img-src 'self' data:",
      "frame-ancestors 'none'",
      // default-src does not cover these two: an injected <base> or <form> could point elsewhere.
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Cache-Control": "no-store",
  };

  const app = Fastify({
    trustProxy: config.trustedProxies.length > 0 ? config.trustedProxies : false,
    // Malformed URLs (e.g. "/%zz"). Fastify answers them before routing, with a context that has
    // no hooks, so the headers and the log line are applied here.
    frameworkErrors: (_error, request, reply: FastifyReply) => {
      reply.code(400).headers(headers).send({ error: "Bad Request" });
      logRequest(request, reply);
    },
    // Requests Node's HTTP parser rejects never reach Fastify: answer them raw, with the same headers.
    clientErrorHandler: (error: NodeJS.ErrnoException, socket) => {
      if (error.code === "ECONNRESET" || !socket.writable) return socket.destroy();
      const status = error.code === "HPE_HEADER_OVERFLOW" ? 431 : error.code === "ERR_HTTP_REQUEST_TIMEOUT" ? 408 : 400;
      const body = JSON.stringify({ error: STATUS_CODES[status] });
      const lines = Object.entries({
        ...headers,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        Connection: "close",
      }).map(([name, value]) => `${name}: ${value}`);
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n${lines.join("\r\n")}\r\n\r\n${body}`);
      app.log.info({ ip: logIp(socket.remoteAddress), status, userId: null }, "client error");
    },
    bodyLimit: 16 * 1024,
    // One line per request from the onResponse hook instead of Fastify's two.
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: config.nodeEnv === "test" ? "silent" : "info",
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      redact: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]'],
      // Cast: Fastify's type demands message and stack, which database errors deliberately lack.
      // req: Fastify's own lines (all switched off above) would carry the full address and the query string.
      serializers: {
        err: serializeError as (err: Error) => { type: string; message: string; stack: string },
        req: (request: FastifyRequest) => ({ method: request.method, url: logPath(request.url), remoteAddress: logIp(request.ip) }),
      },
      ...(deps.logStream && { stream: deps.logStream }),
    },
  });

  // An idle client losing its connection (e.g. a PostgreSQL restart) must not crash the process;
  // the pool replaces the client and /healthz reports any outage.
  deps.pool.on("error", (error) => app.log.error({ err: error }, "idle database client failed"));

  // onSend runs for every reply, including errors, 404s and static files.
  app.addHook("onSend", async (request, reply, payload) => {
    reply.headers(headers);
    // Vite puts a content hash into every file name under /assets/.
    if (request.url.startsWith("/assets/") && reply.statusCode < 400) {
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
    }
    // The hash is part of the URL, so a new avatar gets a new URL (spec 5.1). Private: needs a session.
    if (request.routeOptions.url === "/avatars/:userId/:hash" && reply.statusCode === 200) {
      reply.header("Cache-Control", "private, max-age=31536000, immutable");
    }
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => logRequest(request, reply));

  // The built index.html is a template: Open Graph needs absolute URLs, so __BASE_URL__ is filled in
  // here, once. config.ts already allows only a plain origin; escaping is the second line of defence.
  // Without a build (server-only development) the SPA routes answer 404.
  let spaHtml: string | null = null;
  try {
    spaHtml = readFileSync(path.join(deps.webRoot, "index.html"), "utf8").replaceAll("__BASE_URL__", escapeHtml(config.baseUrl.origin));
  } catch (err) {
    app.log.warn({ err }, "no index.html in the web root, the app pages are unavailable");
  }
  // The app's stylesheet, for the server-rendered pages (legal, 404).
  const appCss = spaHtml?.match(/<link rel="stylesheet"[^>]*href="([^"]+\.css)"/)?.[1] ?? null;

  app.setNotFoundHandler((request, reply) => {
    if (/^\/api(\/|\?|$)/.test(request.url)) return reply.code(404).send({ error: "not_found" });
    return reply.code(404).type(HTML).send(notFoundHtml("Diese Seite gibt es nicht. Prüfe den Link oder fang auf der Startseite an.", appCss));
  });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, "request failed");
    return reply.code(status).send({ error: STATUS_CODES[status] ?? "Error" });
  });

  // Per client IP (request.ip honours TRUSTED_PROXIES). Routes opt in with onRequest: app.rateLimit(...),
  // not config.rateLimit: the plugin gives every route its own counter, and Fastify copies each GET into
  // a HEAD route, so config.rateLimit gave HEAD a second, separate budget. The hook is shared by both.
  await app.register(fastifyRateLimit, { global: false });
  // Signs the short-lived login state cookie; key derived from SESSION_SECRET, separate from session ids.
  await app.register(fastifyCookie, { secret: createHmac("sha256", config.sessionSecret).update("cookie-signing").digest() });
  const db = drizzle({ client: deps.pool, casing: "snake_case" });
  const auth = await registerAuth(app, config, db);

  // /healthz is public and touches the database, so it is limited (CodeQL js/missing-rate-limiting).
  // Generous enough for the container healthcheck and the deploy poll, which share one source address.
  app.get("/healthz", { onRequest: app.rateLimit({ max: HEALTHZ_LIMIT_PER_MINUTE, timeWindow: "1 minute" }) }, async (request, reply) => {
    try {
      await deps.pool.query("select 1");
      return reply.type(TEXT).send("ok");
    } catch (err) {
      request.log.warn({ err }, "health check failed");
      return reply.code(503).type(TEXT).send("unavailable");
    }
  });

  app.get("/robots.txt", (_request, reply) => reply.type(TEXT).send(robotsTxt));
  app.get("/impressum", (_request, reply) => reply.type(HTML).send(impressumHtml(config.legal, appCss)));
  app.get("/datenschutz", (_request, reply) => reply.type(HTML).send(datenschutzHtml(config.legal, { ...config.privacyServices, retentionDays: config.retentionDays }, appCss)));

  for (const url of SPA_ROUTES) {
    app.get(url, (_request, reply) => (spaHtml === null ? reply.callNotFound() : reply.type(HTML).send(spaHtml)));
  }

  // The hashed files under /assets/ and the files of src/web/public. index.html only through the
  // routes above, never as the raw template.
  await app.register(fastifyStatic, {
    root: deps.webRoot,
    cacheControl: false,
    dotfiles: "ignore",
    index: false,
    allowedPath: (pathName) => pathName !== "/index.html",
  });

  // Larger client messages close the connection (1009) before they are buffered or parsed.
  // On shutdown every client is told to reconnect (1012). One that never answers the close handshake would
  // otherwise hold the process for ws's 30 s close timeout, past the container's 10 s stop timeout.
  await app.register(fastifyWebsocket, {
    options: { maxPayload: MAX_CLIENT_MESSAGE_BYTES },
    preClose: async () => {
      const server = app.websocketServer;
      const closed = new Promise((resolve) => server.close(resolve));
      for (const client of server.clients) client.close(1012, "Der Server startet neu. Bitte verbinde dich neu.");
      const cutOff = setTimeout(() => {
        for (const client of server.clients) client.terminate();
      }, SHUTDOWN_GRACE_MS);
      await closed;
      clearTimeout(cutOff);
    },
  });
  registerRooms(app, config, db, auth, {
    pingIntervalMs: deps.pingIntervalMs ?? PING_INTERVAL_MS,
    rollCooldownMs: deps.rollCooldownMs ?? ROLL_COOLDOWN_MS,
    simulatedRollDelayMs: deps.simulatedRollDelayMs ?? SIMULATED_ROLL_DELAY_MS,
    randomInt: deps.randomInt ?? randomInt,
  });

  return app;
}

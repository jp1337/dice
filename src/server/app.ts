// HTTP application: security headers, logging, public pages and static files (spec 7, 8).
import { createHmac } from "node:crypto";
import { STATUS_CODES } from "node:http";
import type { Writable } from "node:stream";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest, LogController } from "fastify";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { registerAuth } from "./auth.js";
import type { Config } from "./config.js";
import { datenschutzHtml, impressumHtml } from "./legal.js";
import { robotsTxt } from "./robots.js";

export const HEALTHZ_LIMIT_PER_MINUTE = 120;

export type Deps = {
  pool: Pool;
  webRoot: string; // directory with the Vite build output
  logStream?: Writable; // defaults to stdout
};

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

function logRequest(request: FastifyRequest, reply: FastifyReply) {
  request.log.info(
    {
      ip: request.ip,
      method: request.method,
      path: request.url.split("?")[0], // query strings may carry codes or tokens
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
      app.log.info({ ip: socket.remoteAddress, status, userId: null }, "client error");
    },
    bodyLimit: 16 * 1024,
    // One line per request from the onResponse hook instead of Fastify's two.
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: config.nodeEnv === "test" ? "silent" : "info",
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      redact: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]'],
      // Cast: Fastify's type demands message and stack, which database errors deliberately lack.
      serializers: { err: serializeError as (err: Error) => { type: string; message: string; stack: string } },
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

  app.setNotFoundHandler((request, reply) => {
    if (/^\/api(\/|\?|$)/.test(request.url)) return reply.code(404).send({ error: "not_found" });
    return reply.code(404).type(TEXT).send("Nicht gefunden");
  });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, "request failed");
    return reply.code(status).send({ error: STATUS_CODES[status] ?? "Error" });
  });

  // Per client IP (request.ip honours TRUSTED_PROXIES). Routes opt in with config.rateLimit.
  await app.register(fastifyRateLimit, { global: false });
  // Signs the short-lived login state cookie; key derived from SESSION_SECRET, separate from session ids.
  await app.register(fastifyCookie, { secret: createHmac("sha256", config.sessionSecret).update("cookie-signing").digest() });
  await registerAuth(app, config, drizzle({ client: deps.pool, casing: "snake_case" }));

  // /healthz is public and touches the database, so it is limited (CodeQL js/missing-rate-limiting).
  // Generous enough for the container healthcheck and the deploy poll, which share one source address.
  app.get("/healthz", { config: { rateLimit: { max: HEALTHZ_LIMIT_PER_MINUTE, timeWindow: "1 minute" } } }, async (request, reply) => {
    try {
      await deps.pool.query("select 1");
      return reply.type(TEXT).send("ok");
    } catch (err) {
      request.log.warn({ err }, "health check failed");
      return reply.code(503).type(TEXT).send("unavailable");
    }
  });

  app.get("/robots.txt", (_request, reply) => reply.type(TEXT).send(robotsTxt));
  app.get("/impressum", (_request, reply) => reply.type(HTML).send(impressumHtml(config.legal)));
  app.get("/datenschutz", (_request, reply) => reply.type(HTML).send(datenschutzHtml(config.legal, { ...config.privacyServices, retentionDays: config.retentionDays })));

  // Serves index.html for "/" and the hashed files under /assets/.
  await app.register(fastifyStatic, { root: deps.webRoot, cacheControl: false, dotfiles: "ignore" });

  return app;
}

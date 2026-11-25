import { readFileSync } from "node:fs";
import { connect, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HEALTHZ_LIMIT_PER_MINUTE, serializeError } from "../src/server/app.js";
import { legalEnv, makeApp } from "./helpers.js";

const ROBOTS = "noindex, nofollow, noarchive, nosnippet, noimageindex";
function expectHeaders(headers: Record<string, unknown>) {
  expect(headers["x-robots-tag"]).toBe(ROBOTS);
  expect(headers["content-security-policy"]).toBe(
    "default-src 'self'; connect-src 'self' wss://dice.example.org; img-src 'self' data:; frame-ancestors 'none'",
  );
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("same-origin");
}

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let logs: Awaited<ReturnType<typeof makeApp>>["logs"];

beforeAll(async () => {
  ({ app, logs } = await makeApp({ ...legalEnv, LEGAL_NOTE: "Hinweis <b>fett</b>" }));
});
afterAll(() => app.close());

describe("every kind of response", () => {
  const urls = ["/", "/assets/index-abc123.js", "/does-not-exist", "/api/nope", "/healthz", "/robots.txt", "/impressum", "/datenschutz"];

  it.each(urls)("%s carries X-Robots-Tag and security headers", async (url) => {
    expectHeaders((await app.inject({ url })).headers);
  });

  it.each(["/%zz", "/%", "/assets/%"])("%s (malformed URL) gets 400 through the normal reply path", async (url) => {
    logs.length = 0;
    const res = await app.inject({ url });
    expect(res.statusCode).toBe(400);
    expectHeaders(res.headers);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(logs.find((l) => l.msg === "request")).toMatchObject({ status: 400 });
  });

  it.each(urls)("HEAD %s carries the same headers", async (url) => {
    expectHeaders((await app.inject({ method: "HEAD", url })).headers);
  });

  // nginx answers "/%zz" (400), too large bodies (413) and 502 during a restart itself, without the app's
  // headers; the acceptance harness found that. The example fills them in there, only where the app sent none.
  it("docs/nginx.example.conf adds the same headers to nginx's own responses", async () => {
    const conf = readFileSync(new URL("../docs/nginx.example.conf", import.meta.url), "utf8");
    const headers = (await app.inject({ url: "/" })).headers;
    for (const name of ["X-Robots-Tag", "Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy"]) {
      const variable = conf.match(new RegExp(`^ {4}add_header ${name} +\\$(\\w+) always;$`, "m"))?.[1];
      expect(variable, `server-level add_header ${name} ... always`).toBeDefined();
      const upstream = `upstream_http_${name.toLowerCase().replaceAll("-", "_")}`;
      const fallback = conf.match(new RegExp(`^map \\$${upstream} \\$${variable} \\{ "" "([^"]+)"; default ""; \\}$`, "m"))?.[1];
      expect(fallback, `map for ${name}`).toBeDefined();
      if (name !== "Content-Security-Policy") expect(fallback).toBe(headers[name.toLowerCase()]); // nginx's pages load nothing: stricter CSP
    }
    expect(conf).not.toMatch(/^ {8}add_header/m); // one inside a location would silently drop the server-level ones there
  });

  it("docs/nginx.example.conf logs like the app: shortened IPs, no query strings", () => {
    const conf = readFileSync(new URL("../docs/nginx.example.conf", import.meta.url), "utf8");
    const format = conf.match(/^log_format (\w+) '([^;]+)';$/m);
    expect(format, "a log_format at http level").not.toBeNull();
    const [, name, line] = format!;
    expect(line).toContain("$dice_ip");
    expect(line).not.toMatch(/\$(remote_addr|request|request_uri|args|query_string|http_x_forwarded_for)\b/);
    expect(conf).toMatch(new RegExp(`^ {4}access_log \\S+ ${name};$`, "m"));
    // The map shortens IPv4 to /16 and IPv6 to /48, the same as src/server/log-ip.ts.
    expect(conf).toMatch(/^map \$remote_addr \$dice_ip \{$/m);
  });

  it("also on errors", async () => {
    const res = await app.inject({ method: "POST", url: "/api/nope", payload: "x".repeat(20_000), headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(413); // body limit
    expect(res.json()).toEqual({ error: "Payload Too Large" });
    expect(res.headers["x-robots-tag"]).toBe(ROBOTS);
  });
});

describe("routes", () => {
  it("serves the app and hashed assets with the right caching", async () => {
    const html = await app.inject({ url: "/" });
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-type"]).toMatch(/text\/html/);
    expect(html.headers["cache-control"]).toBe("no-store");
    const asset = await app.inject({ url: "/assets/index-abc123.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("returns 404, as JSON under /api", async () => {
    const page = await app.inject({ url: "/does-not-exist" });
    expect(page.statusCode).toBe(404);
    const api = await app.inject({ url: "/api/nope" });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: "not_found" });
    for (const url of ["/api", "/api?x=1"]) {
      const bare = await app.inject({ url });
      expect(bare.statusCode).toBe(404);
      expect(bare.json()).toEqual({ error: "not_found" });
    }
    const missing = await app.inject({ url: "/assets/missing.js" });
    expect(missing.statusCode).toBe(404);
    expectHeaders(missing.headers);
    expect(missing.headers["cache-control"]).toBe("no-store");
  });

  it("serves robots.txt as text", async () => {
    const res = await app.inject({ url: "/robots.txt" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.body).toMatch(/^User-agent: \*\nDisallow: \/\n/);
  });

  it("returns 503 from /healthz without a database", async () => {
    const res = await app.inject({ url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe("unavailable");
  });

  it("renders the Impressum from the configuration, escaped", async () => {
    const res = await app.inject({ url: "/impressum" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<h1>Impressum</h1>");
    expect(res.body).toContain("Angaben gemäß § 5 DDG");
    expect(res.body).toContain("Erika &#60;Muster&#62;<br>\nc/o Beispiel &#38; Co<br>\nMusterstraße 1<br>\n12345 Musterstadt");
    expect(res.body).toContain('href="mailto:dice@example.org"');
    expect(res.body).toContain("Hinweis &#60;b&#62;fett&#60;/b&#62;");
    expect(res.body).not.toContain("<Muster>");
    expect(res.body).toContain(`<meta name="robots" content="${ROBOTS}">`);
    for (const href of ["/impressum", "/datenschutz", "https://github.com/jp1337/dice"]) expect(res.body).toContain(`href="${href}"`);
  });

  it("shows the controller on the Datenschutz page", async () => {
    const res = await app.inject({ url: "/datenschutz" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("12345 Musterstadt");
  });
  it.each(["/impressum", "/datenschutz", "/does-not-exist"])("%s wears the app's stylesheet and theme", async (url) => {
    const { body } = await app.inject({ url });
    // makeWebRoot serves the source index.html, whose stylesheet is ./style.css; a build has /assets/….css.
    expect(body).toContain('<link rel="stylesheet" href="./style.css">');
    expect(body).toContain('<script src="/theme-init.js"></script>');
  });

  it.each([
    ["/does-not-exist", "Diese Seite gibt es nicht."],
    ["/z/kurz", "Dieser Zuschauer-Link ist nicht mehr aktiv."],
  ])("%s answers 404 with a page and a way back", async (url, text) => {
    const res = await app.inject({ url });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toContain(text);
    expect(res.body).toContain('<a class="button" href="/">Zur Startseite</a>');
  });
});

describe("legal pages without configuration (development)", () => {
  it("say the details are not configured", async () => {
    const { app: bare } = await makeApp();
    for (const url of ["/impressum", "/datenschutz"]) {
      expect((await bare.inject({ url })).body).toContain("nicht konfiguriert");
    }
    await bare.close();
  });
});

describe("request log", () => {
  it("logs one line with shortened ip, method, path, status and user id, without cookies or query", async () => {
    logs.length = 0;
    await app.inject({ url: "/impressum?code=secret", headers: { cookie: "session=secret", authorization: "Bearer secret" } });
    const line = logs.find((l) => l.msg === "request");
    expect(line).toMatchObject({ ip: "127.0.0.0", method: "GET", path: "/impressum", status: 200, userId: null });
    expect(line?.time).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(JSON.stringify(logs)).not.toContain("secret");
  });
});

describe("raw client errors (before Fastify parses the request)", () => {
  beforeAll(() => app.listen({ port: 0, host: "127.0.0.1" }));

  async function rawRequest(request: string) {
    const { port } = app.server.address() as AddressInfo;
    const socket = connect(port, "127.0.0.1");
    socket.end(request);
    let response = "";
    for await (const chunk of socket) response += chunk;
    return response;
  }

  it.each([
    ["a malformed request", "GET / HTTP/1.1\r\nHost: x\r\nBad Header\r\n\r\n", "400"],
    ["oversized headers", `GET / HTTP/1.1\r\nHost: x\r\nX-Big: ${"a".repeat(20_000)}\r\n\r\n`, "431"],
  ])("%s gets the security headers", async (_name, request, status) => {
    const response = await rawRequest(request);
    const [head = ""] = response.split("\r\n\r\n");
    expect(head).toMatch(new RegExp(`^HTTP/1.1 ${status} `));
    const headers = Object.fromEntries(
      head.split("\r\n").slice(1).map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]),
    );
    expectHeaders(headers);
    expect(headers["cache-control"]).toBe("no-store");
  });

  it("logs the client error with the shortened address", async () => {
    logs.length = 0;
    await rawRequest("GET / HTTP/1.1\r\nHost: x\r\nBad Header\r\n\r\n");
    expect(logs.find((l) => l.msg === "client error")).toMatchObject({ ip: "127.0.0.0", status: 400 });
  });
});

describe("forwarded headers", () => {
  const forwarded = { "x-forwarded-for": "203.0.113.7" };

  it("are ignored without TRUSTED_PROXIES", async () => {
    logs.length = 0;
    await app.inject({ url: "/robots.txt", remoteAddress: "192.0.2.10", headers: forwarded });
    expect(logs.find((l) => l.msg === "request")?.ip).toBe("192.0.0.0");
  });

  it("are ignored from an untrusted sender and used from a trusted one", async () => {
    const { app: proxied, logs: proxiedLogs } = await makeApp({ TRUSTED_PROXIES: "192.0.2.0/24" });
    await proxied.inject({ url: "/robots.txt", remoteAddress: "198.51.100.9", headers: forwarded });
    await proxied.inject({ url: "/robots.txt", remoteAddress: "192.0.2.10", headers: forwarded });
    expect(proxiedLogs.filter((l) => l.msg === "request").map((l) => l.ip)).toEqual(["198.51.0.0", "203.0.0.0"]);
    await proxied.close();
  });
});

describe("rate limiting", () => {
  it("limits /healthz per client and keeps the security headers on 429", async () => {
    const { app: limited } = await makeApp();
    try {
      for (let i = 0; i < HEALTHZ_LIMIT_PER_MINUTE; i++) {
        expect((await limited.inject({ url: "/healthz" })).statusCode).toBe(503);
      }
      const res = await limited.inject({ url: "/healthz" });
      expect(res.statusCode).toBe(429);
      expectHeaders(res.headers);
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally {
      await limited.close();
    }
  });
});

describe("error serializer", () => {
  it("keeps message and stack of ordinary errors", () => {
    const err = new Error("boom", { cause: Object.assign(new Error("inner"), { code: "ECONNREFUSED" }) });
    expect(serializeError(err)).toMatchObject({ type: "Error", message: "boom", stack: expect.stringContaining("boom"), cause: { code: "ECONNREFUSED" } });
  });

  it("reduces database errors to SQLSTATE, constraint and table", () => {
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint, Key (discord_id)=(100000000000000001)'), {
      severity: "ERROR", code: "23505", constraint: "users_discord_id_unique", table: "users", detail: "Key (discord_id)=(100000000000000001) already exists.",
    });
    const wrapped = Object.assign(new Error("Failed query: insert ... params: 100000000000000001,erika", { cause: pgError }), { query: "insert ...", params: ["100000000000000001", "erika"] });
    for (const err of [wrapped, pgError]) {
      const out = serializeError(err);
      expect(out).toMatchObject({ code: "23505", constraint: "users_discord_id_unique", table: "users" });
      expect(JSON.stringify(out)).not.toMatch(/100000000000000001|erika|insert|stack/);
    }
  });
});

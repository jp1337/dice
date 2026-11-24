import { connect, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  it("logs one line with ip, method, path, status and user id, without cookies or query", async () => {
    logs.length = 0;
    await app.inject({ url: "/impressum?code=secret", headers: { cookie: "session=secret", authorization: "Bearer secret" } });
    const line = logs.find((l) => l.msg === "request");
    expect(line).toMatchObject({ ip: "127.0.0.1", method: "GET", path: "/impressum", status: 200, userId: null });
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
});

describe("forwarded headers", () => {
  const forwarded = { "x-forwarded-for": "203.0.113.7" };

  it("are ignored without TRUSTED_PROXIES", async () => {
    logs.length = 0;
    await app.inject({ url: "/robots.txt", remoteAddress: "192.0.2.10", headers: forwarded });
    expect(logs.find((l) => l.msg === "request")?.ip).toBe("192.0.2.10");
  });

  it("are ignored from an untrusted sender and used from a trusted one", async () => {
    const { app: proxied, logs: proxiedLogs } = await makeApp({ TRUSTED_PROXIES: "192.0.2.0/24" });
    await proxied.inject({ url: "/robots.txt", remoteAddress: "198.51.100.9", headers: forwarded });
    await proxied.inject({ url: "/robots.txt", remoteAddress: "192.0.2.10", headers: forwarded });
    expect(proxiedLogs.filter((l) => l.msg === "request").map((l) => l.ip)).toEqual(["198.51.100.9", "203.0.113.7"]);
    await proxied.close();
  });
});

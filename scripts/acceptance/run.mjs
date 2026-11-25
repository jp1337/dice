// Acceptance harness (spec 16): the app image behind a real nginx with docs/nginx.example.conf, PostgreSQL 19,
// all in rootless podman. Not part of CI (needs podman and minutes). How to run: docs-tech/acceptance.md.
//   npx tsx scripts/acceptance/run.mjs            # full run, 31 minutes idle WebSocket
//   npx tsx scripts/acceptance/run.mjs --quick    # 3 minutes idle
//   npx tsx scripts/acceptance/run.mjs --idle-minutes=10
// tsx only so the session hash and the ping interval come from the app's own code.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws"; // shortcut: transitive dependency of @fastify/websocket; Node's own WebSocket cannot set Host/SNI or a CA
import { SESSION_COOKIE, sessionIdFor } from "../../src/server/auth.ts";
import { PING_INTERVAL_MS, ROLL_COOLDOWN_MS } from "../../src/shared/constants.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}`));
const idleMinutes = arg("idle-minutes") ? Number(arg("idle-minutes").split("=")[1]) : arg("quick") ? 3 : 31;
if (!(idleMinutes > 0)) throw new Error("--idle-minutes=N needs a positive number");

// Fictitious values only: the repository is public.
const HOST = "dice.example.org";
const ORIGIN = `https://${HOST}`;
const HOST_DISCORD_ID = "100000000000000002";
const FORGED_IP = "203.0.113.66"; // TEST-NET-3
const LOAD_CLIENTS = 100;
const NGINX_IMAGE = process.env.NGINX_IMAGE ?? "docker.io/library/nginx:alpine@sha256:0530961ff0592b58c10f767535cc0abdfccf9e389ff7cc90f87320c1bc7e8506";
// Same PostgreSQL image as production compose.
const PG_IMAGE = readFileSync(path.join(root, "docker-compose.yml"), "utf8").match(/image: (postgres:\S+)/)[1].replace(/^/, "docker.io/library/");

const run = `dice-acc-${randomBytes(3).toString("hex")}`;
const names = { net: `${run}-net`, pg: `${run}-pg`, app: `${run}-app`, nginx: `${run}-nginx`, image: `localhost/${run}:latest` };
const tmp = mkdtempSync(path.join(tmpdir(), `${run}-`));
const log = (text) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);
const podman = (...args) => execFileSync("podman", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Teardown: always, also on Ctrl-C. Synchronous so it finishes inside a signal handler.

let tornDown = false;
function teardown() {
  if (tornDown) return;
  tornDown = true;
  log("teardown");
  spawnSync("podman", ["rm", "-f", "-v", "-t", "0", names.nginx, names.app, names.pg], { stdio: "ignore" });
  spawnSync("podman", ["network", "rm", "-f", names.net], { stdio: "ignore" });
  spawnSync("podman", ["rmi", "-f", names.image], { stdio: "ignore" });
  rmSync(tmp, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    teardown();
    process.exit(130);
  });
}

// ---------------------------------------------------------------------------------------------
// Clients: HTTPS and WebSocket to nginx's published port, with SNI and Host dice.example.org.

let nginxPort = 0;
let ca = "";

function http(pathName, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: nginxPort, path: pathName, method, servername: HOST, ca, agent: false, headers: { host: HOST, ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`timeout on ${pathName}`)));
    req.end(body);
  });
}

// One room socket. Keeps the latest state and calls onState for every one.
function connect(user, slug) {
  const ws = new WebSocket(`wss://127.0.0.1:${nginxPort}/ws/rooms/${slug}`, {
    headers: { host: HOST, cookie: `${SESSION_COOKIE}=${user.token}` },
    origin: ORIGIN,
    servername: HOST,
    ca,
  });
  const client = { ws, user, state: null, pings: 0, closed: null, rejected: null, messages: [], onState: null };
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    client.messages.push(message);
    if (message.type === "state") {
      client.state = message.state;
      client.onState?.(message.state, performance.now());
    }
  });
  ws.on("ping", () => client.pings++);
  ws.on("unexpected-response", (_req, res) => {
    client.rejected = { status: res.statusCode, robots: res.headers["x-robots-tag"] ?? null };
    res.resume();
    ws.terminate();
  });
  ws.on("error", () => {}); // a close follows
  ws.on("close", (code) => (client.closed = { code, at: performance.now() }));
  return client;
}

async function until(check, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(10);
  }
}

// JSON paths where two values differ, with both values.
function differences(a, b, at = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object") {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => differences(a[key], b[key], `${at}.${key}`));
  }
  return [`${at || "."}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`];
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const ms = (value) => `${Math.round(value)} ms`;

// ---------------------------------------------------------------------------------------------
// Setup

const users = { host: null, load: [], idle: null, restart: [] };
let ips;

async function setup() {
  // Network with fixed addresses: nginx must be the only trusted proxy (TRUSTED_PROXIES), and the probe
  // client gets an address of its own so the log can be checked against it.
  podman("network", "create", names.net);
  const subnet = podman("network", "inspect", names.net, "--format", "{{range .Subnets}}{{.Subnet}}{{end}}");
  const prefix = subnet.match(/^(\d+\.\d+\.\d+)\.0\/24$/)?.[1];
  if (!prefix) throw new Error(`unexpected subnet ${subnet}`);
  ips = { nginx: `${prefix}.10`, app: `${prefix}.11`, pg: `${prefix}.12`, client: `${prefix}.50` };

  const pgPassword = randomBytes(16).toString("hex");
  log(`postgres ${PG_IMAGE}`);
  podman("run", "-d", "--name", names.pg, "--network", names.net, "--ip", ips.pg,
    "-e", "POSTGRES_USER=dice", "-e", "POSTGRES_DB=dice", "-e", `POSTGRES_PASSWORD=${pgPassword}`, PG_IMAGE);

  log("building the app image from the Dockerfile (docker format keeps the HEALTHCHECK; cached layers make reruns fast)");
  execFileSync("podman", ["build", "-q", "--format", "docker", "-t", names.image, root], { stdio: ["ignore", "ignore", "inherit"] });

  // Throwaway certificate, valid for a day.
  const certs = path.join(tmp, "certs");
  mkdirSync(certs);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${HOST}`,
    "-addext", `subjectAltName=DNS:${HOST}`, "-keyout", path.join(certs, "key.pem"), "-out", path.join(certs, "cert.pem")], { stdio: "ignore" });
  ca = readFileSync(path.join(certs, "cert.pem"), "utf8");

  // docs/nginx.example.conf as it is, with only the upstream address and the certificate paths filled in.
  const example = readFileSync(path.join(root, "docs/nginx.example.conf"), "utf8");
  const replacements = [
    [/proxy_pass http:\/\/127\.0\.0\.1:3000;/g, `proxy_pass http://${ips.app}:3000;`],
    [/# ssl_certificate {5}\S+;/, "ssl_certificate     /etc/nginx/certs/cert.pem;"],
    [/# ssl_certificate_key \S+;/, "ssl_certificate_key /etc/nginx/certs/key.pem;"],
  ];
  let conf = example;
  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(conf)) throw new Error(`docs/nginx.example.conf changed: ${pattern} not found, update the harness`);
    conf = conf.replace(pattern, replacement);
  }
  writeFileSync(path.join(tmp, "nginx.conf"), conf);
  podman("run", "-d", "--name", names.nginx, "--network", names.net, "--ip", ips.nginx, "-p", "127.0.0.1::443",
    "-v", `${path.join(tmp, "nginx.conf")}:/etc/nginx/conf.d/default.conf:ro,Z`, "-v", `${certs}:/etc/nginx/certs:ro,Z`, NGINX_IMAGE);
  nginxPort = Number(podman("port", names.nginx, "443/tcp").split(":").pop());

  await until(() => spawnSync("podman", ["exec", names.pg, "pg_isready", "-h", "127.0.0.1", "-U", "dice", "-d", "dice"]).status === 0, 60_000, "PostgreSQL");

  const sessionSecret = randomBytes(48).toString("base64");
  const env = {
    NODE_ENV: "production", // as in production; NODE_ENV=test would also silence the log that check 3 reads
    BASE_URL: ORIGIN,
    DATABASE_URL: `postgres://dice:${pgPassword}@${ips.pg}:5432/dice`,
    SESSION_SECRET: sessionSecret,
    DISCORD_CLIENT_ID: "100000000000000009",
    DISCORD_CLIENT_SECRET: "acceptance-client-secret",
    DISCORD_GUILD_ID: "100000000000000001",
    HOST_DISCORD_IDS: HOST_DISCORD_ID,
    TRUSTED_PROXIES: ips.nginx,
    LEGAL_NAME: "Erika Mustermann",
    LEGAL_ADDRESS: "Musterstraße 1|12345 Musterstadt",
    LEGAL_EMAIL: "dice@example.org",
  };
  // The app's address stays the same across the restart in check 5; nginx resolved it once.
  podman("run", "-d", "--name", names.app, "--network", names.net, "--ip", ips.app,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]), names.image);
  await waitHealthy(90_000);

  // Users and sessions straight into the database, as test/rooms.test.ts does: there is no real Discord here.
  // The session cookie is then checked by the app's real code on every request and upgrade.
  const make = (discordId, name) => ({ id: randomUUID(), discordId, name, token: randomBytes(32).toString("base64url") });
  users.host = make(HOST_DISCORD_ID, "Henrike Host");
  users.load = Array.from({ length: LOAD_CLIENTS }, (_, i) => make(`1000000000001${String(i).padStart(5, "0")}`, `Spieler ${i + 1}`));
  users.idle = make("100000000000200000", "Ida Idle");
  users.restart = [make("100000000000200001", "Rolf Restart"), make("100000000000200002", "Rita Restart")];
  const all = [users.host, ...users.load, users.idle, ...users.restart];
  const sql = ["begin;"];
  for (const u of all) {
    sql.push(`insert into users (id, discord_id, username, display_name) values ('${u.id}', '${u.discordId}', 'u${u.discordId.slice(-6)}', '${u.name}');`);
    sql.push(`insert into sessions (id, user_id, expires_at) values ('${sessionIdFor(sessionSecret, u.token)}', '${u.id}', now() + interval '1 day');`);
  }
  sql.push("commit;");
  execFileSync("podman", ["exec", "-i", names.pg, "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "dice", "-d", "dice"], { input: sql.join("\n"), stdio: ["pipe", "ignore", "inherit"] });
}

async function waitHealthy(timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const res = await http("/healthz").catch(() => null);
    if (res?.status === 200) return;
    if (Date.now() > end) {
      const logs = spawnSync("podman", ["logs", "--tail", "30", names.app], { encoding: "utf8" });
      console.error(logs.stdout + logs.stderr);
      throw new Error(`app not healthy through nginx after ${timeoutMs} ms (last status ${res?.status ?? "none"})`);
    }
    await sleep(500);
  }
}

async function createRoom(name) {
  const res = await http("/api/rooms", {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${users.host.token}`, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ name, isTest: false }),
  });
  if (res.status !== 201) throw new Error(`creating a room: ${res.status} ${res.body}`);
  return JSON.parse(res.body).slug;
}

// ---------------------------------------------------------------------------------------------
// Checks. Each returns a one-line reason and throws (or returns ok: false) on failure.

const results = [];
async function check(name, fn) {
  log(`check: ${name}`);
  try {
    const { ok, reason } = await fn();
    results.push({ name, ok, reason });
  } catch (err) {
    results.push({ name, ok: false, reason: err.message });
  }
  const last = results.at(-1);
  console.log(`${last.ok ? "PASS" : "FAIL"}  ${name}: ${last.reason}`);
}

// 1. The stack itself: wired like production.
async function stack() {
  const res = await http("/healthz");
  const server = res.headers.server ?? "";
  const pgVersion = podman("exec", names.pg, "psql", "-tA", "-U", "dice", "-d", "dice", "-c", "show server_version");
  const ok = res.status === 200 && server.startsWith("nginx") && pgVersion.startsWith("19");
  return { ok, reason: `TLS via ${server}, /healthz ${res.status}, PostgreSQL ${pgVersion}, TRUSTED_PROXIES=${ips.nginx} (nginx only)` };
}

// 2. Headers against indexing and for the browser, on every kind of response.
async function headers(slug) {
  const index = await http("/");
  const asset = index.body.match(/\/assets\/[\w.-]+\.js/)?.[0];
  if (!asset) throw new Error("no /assets/*.js in index.html");
  const paths = ["/", `/r/${slug}`, "/impressum", "/datenschutz", "/robots.txt", "/healthz", asset, "/does-not-exist", "/r/short", "/%zz", "/api/me"];
  const expected = {
    "x-robots-tag": (v) => v === "noindex, nofollow, noarchive, nosnippet, noimageindex",
    "content-security-policy": (v) => typeof v === "string" && v.includes("default-src") && v.includes("frame-ancestors 'none'"),
    "x-content-type-options": (v) => v === "nosniff",
    "referrer-policy": (v) => v === "same-origin",
  };
  const problems = [];
  const statuses = [];
  for (const p of paths) {
    const res = await http(p);
    statuses.push(`${p === asset ? "/assets/…" : p.length > 20 ? `${p.slice(0, 12)}…` : p} ${res.status}`);
    for (const [name, ok] of Object.entries(expected)) if (!ok(res.headers[name])) problems.push(`${p} (${res.status}): ${name}=${res.headers[name] ?? "missing"}`);
  }
  return problems.length > 0
    ? { ok: false, reason: problems.join("; ") }
    : { ok: true, reason: `all 4 headers on ${paths.length} responses: ${statuses.join(", ")}` };
}

// 3. Client address: what nginx forwards, never what a client claims.
async function clientIp() {
  const id = randomBytes(4).toString("hex");
  const probes = { proxied: `/acc-${id}-proxied`, forgedProxied: `/acc-${id}-forged-proxied`, forgedDirect: `/acc-${id}-forged-direct` };
  const curl = `curl -sk -o /dev/null --resolve ${HOST}:443:${ips.nginx}`;
  const script = [
    `${curl} https://${HOST}${probes.proxied}`,
    `${curl} -H 'X-Forwarded-For: ${FORGED_IP}' https://${HOST}${probes.forgedProxied}`,
    // Straight to the app port, bypassing nginx, with a forged header.
    `curl -s -o /dev/null -H 'Host: ${HOST}' -H 'X-Forwarded-For: ${FORGED_IP}' -H 'X-Forwarded-Proto: https' http://${ips.app}:3000${probes.forgedDirect}`,
  ].join(" && ");
  podman("run", "--rm", "--network", names.net, "--ip", ips.client, "--entrypoint", "sh", NGINX_IMAGE, "-c", script);
  await sleep(500);
  const lines = podman("logs", names.app)
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const problems = [];
  const seen = [];
  for (const [name, p] of Object.entries(probes)) {
    const line = lines.find((l) => l.msg === "request" && l.path === p);
    if (!line) problems.push(`${name}: no log line`);
    else if (line.ip !== ips.client) problems.push(`${name}: logged ${line.ip}, expected ${ips.client}`);
    else seen.push(`${name}=${line.ip}`);
  }
  return problems.length > 0
    ? { ok: false, reason: problems.join("; ") }
    : { ok: true, reason: `client ${ips.client}, nginx ${ips.nginx}, forged ${FORGED_IP}; logged ${seen.join(", ")}` };
}

// 4. A silent WebSocket through nginx stays open: only the server's pings run.
async function idle() {
  const slug = await createRoom("Leerlauf");
  const client = connect(users.idle, slug);
  await until(() => client.state || client.closed, 15_000, "the first state");
  if (!client.state) throw new Error(`no state, closed with ${client.closed?.code}`);
  const start = performance.now();
  const idleMs = idleMinutes * 60_000;
  log(`  idle for ${idleMinutes} min (no application messages)`);
  while (performance.now() - start < idleMs && !client.closed) await sleep(1000);
  if (client.closed) {
    return { ok: false, reason: `closed with ${client.closed.code} after ${Math.round((client.closed.at - start) / 1000)} s idle, ${client.pings} pings` };
  }
  // Still open is not enough: a half-open socket would look the same. One round trip proves it.
  const before = client.messages.length;
  client.ws.send(JSON.stringify({ type: "no_such_message" }));
  await until(() => client.messages.length > before || client.closed, 10_000, "an answer after the idle time");
  const answer = client.messages.at(-1);
  client.ws.close();
  const minPings = Math.floor(idleMs / PING_INTERVAL_MS) - 1;
  const ok = answer?.code === "invalid_message" && client.pings >= minPings;
  return { ok, reason: `open after ${idleMinutes} min idle, ${client.pings} server pings (≥ ${minPings} expected), round trip ${answer?.type}/${answer?.code}` };
}

// 6. 100 clients in one room: time until everyone sees everyone, and one broadcast's latency.
async function load() {
  const slug = await createRoom("Last");
  const host = connect(users.host, slug);
  await until(() => host.state, 15_000, "the host's state");
  const t0 = performance.now();
  const clients = users.load.map((u) => connect(u, slug));
  const firstState = new Map();
  const everyone = new Map();
  const total = LOAD_CLIENTS + 1; // with the host, who created the room
  for (const c of clients) {
    c.onState = (state, at) => {
      if (!firstState.has(c)) firstState.set(c, at - t0);
      if (!everyone.has(c) && state.members.length === total && state.members.every((m) => m.connected)) everyone.set(c, at - t0);
    };
  }
  await until(() => everyone.size === LOAD_CLIENTS || clients.some((c) => c.closed), 60_000, "all clients to see all members");
  const closed = clients.filter((c) => c.closed);
  if (closed.length > 0) throw new Error(`${closed.length} clients closed (first code ${closed[0].closed.code}, rejected ${JSON.stringify(closed[0].rejected)})`);
  const firstMax = Math.max(...firstState.values());
  const allMax = Math.max(...everyone.values());

  // Broadcast: the host moves one player to the spectators; time until each client's state shows it.
  const target = users.load[0].id;
  const latency = new Map();
  let sent = 0;
  for (const c of clients) {
    c.onState = (state, at) => {
      if (!latency.has(c) && state.members.find((m) => m.userId === target)?.participation === "spectator") latency.set(c, at - sent);
    };
  }
  sent = performance.now();
  host.ws.send(JSON.stringify({ type: "set_participation", userId: target, participation: "spectator" }));
  await until(() => latency.size === LOAD_CLIENTS, 30_000, "the broadcast to reach all clients");
  const sorted = [...latency.values()].sort((a, b) => a - b);
  for (const c of [host, ...clients]) c.ws.close();
  const [p50, p95, max] = [percentile(sorted, 50), percentile(sorted, 95), sorted.at(-1)];
  // "Without noticeable delay" (spec 16): a broadcast under a second at p95.
  const ok = p95 < 1000;
  return { ok, reason: `${LOAD_CLIENTS} clients: first state for all after ${ms(firstMax)}, all see ${total} connected members after ${ms(allMax)} (presence is batched up to 2 s); broadcast p50 ${ms(p50)}, p95 ${ms(p95)}, max ${ms(max)}` };
}

// Sends a message and waits for done(); throws on an error answer.
async function command(client, message, done) {
  const seen = client.messages.length;
  client.ws.send(JSON.stringify(message));
  const error = () => client.messages.slice(seen).find((m) => m.type === "error");
  await until(() => done() || error(), 10_000, `${message.type} to take effect`);
  if (!done()) throw new Error(`${message.type}: ${error().code}`);
}

// n real rolls: from the active player's own socket if connected, else the host rolls for them.
// A six pauses the game until the host continues; the cooldown is waited out.
async function rolls(sessions, n) {
  const host = () => sessions[0].client;
  const count = () => host().state.game.history.filter((e) => e.type === "rolled").length;
  const target = count() + n;
  while (count() < target) {
    const game = host().state.game;
    if (game.status !== "running") throw new Error(`game ${game.status} after ${count()} rolls`);
    if (game.pause === "six") {
      await command(host(), { type: "continue" }, () => host().state.game.pause === null);
      continue;
    }
    const own = sessions.find((s) => s.user.id === game.activeUserId)?.client;
    const [client, message] = own ? [own, { type: "roll" }] : [host(), { type: "roll_for", userId: game.activeUserId }];
    const before = count();
    const seen = client.messages.length;
    client.ws.send(JSON.stringify(message));
    const error = () => client.messages.slice(seen).find((m) => m.type === "error");
    await until(() => count() > before || error(), 10_000, "a roll");
    if (error()?.code === "cooldown") await sleep(250);
    else if (error()) throw new Error(`${message.type}: ${error().code}`);
  }
  const turn = (s) => JSON.stringify([s.client.state.game.lastRoll, s.client.state.game.activeUserId, s.client.state.game.giftOrder]);
  await until(() => sessions.every((s) => turn(s) === turn(sessions[0])), 5_000, "the last roll to reach everyone");
}

// Right after the restart a fresh host socket rolls as soon as the app is back. Within 2 s of the last roll
// it must be refused with "cooldown"; a roll accepted inside the window means the cooldown was lost.
async function probeCooldown(slug, lastRollAt) {
  for (;;) {
    const client = connect(users.host, slug);
    await until(() => client.state || client.closed, 5_000, "the app to accept a socket").catch(() => {});
    if (!client.state) {
      client.ws.terminate();
      await sleep(50);
      continue;
    }
    const game = client.state.game;
    if (game.pause === "six") return { after: 0, problem: "cooldown not probed: the last roll was a six" };
    const after = Date.now() - lastRollAt;
    const seen = client.messages.length;
    client.ws.send(JSON.stringify({ type: "roll_for", userId: game.activeUserId }));
    const answer = () => client.messages.slice(seen).find((m) => m.type === "error" || m.type === "state");
    await until(answer, 5_000, "an answer to the probe");
    client.ws.close();
    const code = answer().type === "error" ? answer().code : null;
    if (code === "cooldown") return { after, code };
    const why = after >= ROLL_COOLDOWN_MS ? `the app was back only ${after} ms after the last roll` : `answered ${code ?? "with a roll"}, expected cooldown`;
    return { after, code, accepted: code === null, problem: `cooldown not shown after the restart: ${why}` };
  }
}

// 5. Restart the app container under 3 connected clients: they come back by themselves, nothing is lost.
async function restart() {
  const slug = await createRoom("Neustart");
  const people = [users.host, ...users.restart];
  // The client's reconnect loop (spec 8.1): growing delay with jitter, then the current state.
  const sessions = people.map((user) => ({ user, client: connect(user, slug), attempts: 0, rejected: [], stop: false }));
  const loop = async (s) => {
    for (let delay = 250; !s.stop; delay = Math.min(delay * 2, 4000)) {
      await until(() => s.client.closed || s.stop, 600_000, "a close");
      if (s.stop) return;
      if (s.client.rejected) s.rejected.push(s.client.rejected);
      await sleep(delay / 2 + Math.random() * delay);
      s.attempts++;
      s.client = connect(s.user, slug);
      await until(() => s.client.state || s.client.closed, 15_000, "a state or a close").catch(() => {});
      if (s.client.state) delay = 125; // connected again: the next outage starts small
    }
  };
  const all = () => sessions.every((s) => s.client.state && s.client.state.members.filter((m) => m.connected).length === people.length);
  await until(all, 15_000, "3 clients connected");
  for (const s of sessions) s.first = s.client;
  const loops = sessions.map(loop);

  // Four more players who leave again before the start: the host rolls for them (roll_for).
  const offline = users.load.slice(1, 5).map((u) => connect(u, slug));
  await until(() => offline.every((c) => c.state), 15_000, "the offline players to join");
  for (const c of offline) c.ws.close();

  // Something to lose: a co-host (an event and a member row) and real rolls mid-game (spec 16).
  const host = sessions[0].client;
  const cohost = users.restart[0].id;
  await command(host, { type: "set_cohost", userId: cohost, isCohost: true }, () => sessions.every((s) => s.client.state.members.find((m) => m.userId === cohost)?.isCohost));
  await command(host, { type: "start" }, () => host.state.room.status === "running");
  await rolls(sessions, 3);
  while (host.state.game.giftOrder.length === 0) await rolls(sessions, 1); // a six, so the gift order is not empty
  while (host.state.game.pause === "six") await rolls(sessions, 1); // the cooldown probe needs a game that is not paused
  const lastRoll = host.state.game.history.findLast((e) => e.type === "rolled");
  const comparable = (state) => ({ ...state, members: state.members.map(({ connected: _, ...m }) => m) });
  const before = sessions.map((s) => comparable(s.client.state));

  const t0 = performance.now();
  // Asynchronously: a blocking call would freeze these clients, and they could not answer the close handshake.
  const code = await new Promise((resolve) => spawn("podman", ["restart", "-t", "10", names.app], { stdio: "ignore" }).on("exit", resolve));
  if (code !== 0) throw new Error(`podman restart exited with ${code}`);
  const restartedAfter = performance.now() - t0;
  // The 2 s roll cooldown must survive the restart: a fresh host socket asks for the next roll at once.
  const probe = await probeCooldown(slug, Date.parse(lastRoll.createdAt));
  await until(() => sessions.every((s) => s.client !== s.first && s.client.state && !s.client.closed) && all(), 120_000, "all 3 clients back with a state");
  const backAfter = performance.now() - t0;
  await sleep(500); // presence after the reconnects is batched
  const after = sessions.map((s) => comparable(s.client.state));

  // The game goes on where it stopped: two more rolls, numbered without a gap.
  await rolls(sessions, 2);
  const history = sessions[0].client.state.game.history; // the host's: every event
  const seqs = history.map((e) => e.seq);
  const rolled = (h) => h.filter((e) => e.type === "rolled").length;
  const gapless = seqs.every((seq, i) => seq === i + 1) && rolled(history) === rolled(before[0].game.history) + 2 + (probe.accepted ? 1 : 0);
  for (const s of sessions) s.stop = true;
  for (const s of sessions) s.client.ws.close();
  await Promise.all(loops);
  const differ = sessions.flatMap((s, i) => {
    const paths = differences(before[i], after[i]);
    return paths.length > 0 ? [`${s.user.name} at ${paths.slice(0, 3).join(", ")}`] : [];
  });
  // Every refused reconnect came from nginx while the app was down; those must carry X-Robots-Tag too (spec 8.4).
  const refused = sessions.flatMap((s) => s.rejected);
  const unlabelled = refused.filter((r) => !r.robots);
  const problems = [
    ...(differ.length > 0 ? [`state differs for ${differ.join(", ")}`] : []),
    ...(probe.problem ? [probe.problem] : []),
    ...(gapless ? [] : [`events after the restart: seqs ${seqs.join(",")}, ${rolled(history)} rolls`]),
    ...(unlabelled.length > 0 ? [`${unlabelled.length} nginx error responses without X-Robots-Tag (status ${unlabelled[0].status})`] : []),
  ];
  const statuses = [...new Set(refused.map((r) => r.status))].join("/") || "none";
  const reason = `restart took ${ms(restartedAfter)}, all 3 back with identical state (${before[0].game.history.length} events, ${rolled(before[0].game.history)} rolls, ${before[0].game.giftOrder.length} gift places, co-host) after ${ms(backAfter)}; a roll ${probe.after} ms after the last one: ${probe.code ?? "not refused"}; then 2 more rolls, seqs 1..${seqs.at(-1)} without gaps; ${sessions.reduce((n, s) => n + s.attempts, 0)} reconnect attempts, refused meanwhile: ${statuses}`;
  return problems.length > 0 ? { ok: false, reason: `${problems.join("; ")} (${reason})` } : { ok: true, reason };
}

// ---------------------------------------------------------------------------------------------

let exitCode = 1;
try {
  log(`run ${run}, idle ${idleMinutes} min, temp ${tmp}`);
  await setup();
  const slug = await createRoom("Kopfzeilen");
  await check("1 stack: nginx (TLS) → app image → PostgreSQL 19", stack);
  await check("2 headers on every response through nginx", () => headers(slug));
  await check("3 client IP from nginx, forged X-Forwarded-For ignored", clientIp);
  await check(`4 WebSocket idle ${idleMinutes} min through nginx`, idle);
  await check(`6 load: ${LOAD_CLIENTS} WebSocket clients in one room`, load);
  await check("5 app restart with 3 connected clients", restart);
  console.log("\nSummary");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  exitCode = results.every((r) => r.ok) && results.length === 6 ? 0 : 1;
} catch (err) {
  console.error(`setup failed: ${err.stack ?? err}`);
} finally {
  teardown();
}
process.exit(exitCode);

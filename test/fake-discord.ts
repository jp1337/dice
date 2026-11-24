// A local stand-in for the Discord API and CDN (spec 13). Each test sets `state` before logging in.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const ACCESS_TOKEN = "fake-access-token-must-never-be-logged";
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body")]);

export type FakeState = {
  user: { id: string; username: string; global_name?: string | null; avatar?: string | null };
  member: { nick?: string | null; avatar?: string | null } | null; // null = not on the server (404)
  failStatus?: { token?: number; user?: number; member?: number };
  avatar: { status?: number; type?: string; body?: Buffer; delayMs?: number; redirect?: string; chunked?: boolean };
};

export async function startFakeDiscord() {
  const fake = {
    state: undefined as unknown as FakeState,
    avatarRequests: [] as string[],
    tokenForms: [] as URLSearchParams[],
    url: "",
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  };
  const authorized = (req: IncomingMessage) => req.headers.authorization === `Bearer ${ACCESS_TOKEN}`;

  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://fake");
    const s = fake.state;
    if (req.method === "POST" && pathname === "/v10/oauth2/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      fake.tokenForms.push(new URLSearchParams(body));
      if (s.failStatus?.token) return json(res, s.failStatus.token, { error: "invalid_grant" });
      return json(res, 200, { access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 604800, refresh_token: "fake-refresh", scope: "identify guilds.members.read" });
    }
    if (pathname === "/v10/users/@me") {
      if (!authorized(req)) return json(res, 401, { message: "401: Unauthorized", code: 0 });
      if (s.failStatus?.user) return json(res, s.failStatus.user, {});
      return json(res, 200, s.user);
    }
    if (/^\/v10\/users\/@me\/guilds\/\d+\/member$/.test(pathname)) {
      if (!authorized(req)) return json(res, 401, { message: "401: Unauthorized", code: 0 });
      if (s.failStatus?.member) return json(res, s.failStatus.member, {});
      if (!s.member) return json(res, 404, { message: "Unknown Guild", code: 10004 });
      return json(res, 200, { ...s.member, user: s.user, roles: [], joined_at: "2026-01-01T00:00:00.000Z" });
    }
    if (/^\/(avatars|guilds)\//.test(pathname)) {
      fake.avatarRequests.push(req.url ?? "");
      const a = s.avatar;
      if (a.delayMs) await new Promise((resolve) => setTimeout(resolve, a.delayMs));
      // "foreign": the same fake under another host name, so following the redirect would succeed.
      if (a.redirect) return res.writeHead(302, { Location: a.redirect === "foreign" ? fake.url.replace("127.0.0.1", "localhost") + "/avatars/x.png" : a.redirect }).end();
      const body = a.body ?? PNG;
      const headers: Record<string, string> = { "Content-Type": a.type ?? "image/png" };
      if (!a.chunked) headers["Content-Length"] = String(body.length);
      res.writeHead(a.status ?? 200, headers);
      return res.end(body);
    }
    json(res, 404, { message: "404: Not Found", code: 0 });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

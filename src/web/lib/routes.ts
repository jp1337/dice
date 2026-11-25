// The two pages of the app, picked from the path without a router library. Every page is a full
// page load: the server sends the same HTML for each (SPA_ROUTES in app.ts).

export type Route = { page: "start" } | { page: "room"; slug: string };

// The slug alphabet of app.ts (base64url, 16 to 64).
const ID = "([A-Za-z0-9_-]{16,64})";

export function parseRoute(pathname: string): Route {
  const room = new RegExp(`^/r/${ID}/?$`).exec(pathname);
  if (room) return { page: "room", slug: room[1]! };
  return { page: "start" };
}

// After the login Discord sends the user back to the page they came from (spec 5: own relative paths only).
export function loginHref(here: string) {
  return here === "/" ? "/auth/login" : `/auth/login?next=${encodeURIComponent(here)}`;
}

export function socketUrl(location: { protocol: string; host: string }, path: string) {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
}

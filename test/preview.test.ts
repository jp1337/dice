// Link preview (spec 10.2): Open Graph tags in the served HTML, identical for every page, absolute
// image URL from BASE_URL, nothing about any room.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
beforeAll(async () => ({ app } = await makeApp()));
afterAll(() => app.close());

// Room slugs are base64url, 16 to 64 characters (the rooms step generates them).
const pages = ["/", "/r/weihnachten-2026", "/r/AnotherRoom_slug-0123456789"];

describe("the SPA HTML", () => {
  it.each(pages)("%s carries the Open Graph tags with an absolute image URL", async (url) => {
    const res = await app.inject({ url });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.headers["cache-control"]).toBe("no-store");
    for (const property of ["og:title", "og:description", "og:image", "og:type"]) {
      expect(res.body).toContain(`<meta property="${property}" content="`);
    }
    expect(res.body).toContain('<meta property="og:image" content="https://dice.example.org/og.png"');
    expect(res.body).not.toContain("__BASE_URL__");
  });

  it("is the same for every page and names no room", async () => {
    const bodies = await Promise.all(pages.map(async (url) => (await app.inject({ url })).body));
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toMatch(/weihnachten|AnotherRoom/);
  });

  it("uses the configured BASE_URL", async () => {
    const { app: other } = await makeApp({ BASE_URL: "https://wuerfel.example.net/" });
    const res = await other.inject({ url: "/r/abcdefghijklmnop" });
    expect(res.body).toContain('content="https://wuerfel.example.net/og.png"');
    await other.close();
  });

  it.each(["/r/", "/r/too-short", "/r/" + "a".repeat(65), "/r/not.base64url.slug", "/r/weihnachten-2026/extra"])("%s is not a room page: 404", async (url) => {
    expect((await app.inject({ url })).statusCode).toBe(404);
  });

  it("is never served as the raw template", async () => {
    expect((await app.inject({ url: "/index.html" })).statusCode).toBe(404);
  });
});

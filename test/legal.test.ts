import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/server/config.js";
import { datenschutzHtml, PRIVACY_UPDATED } from "../src/server/legal.js";
import { baseEnv, legalEnv, makeApp } from "./helpers.js";

const legal = parseConfig({ ...baseEnv, ...legalEnv }).legal;

describe("Datenschutzhinweis", () => {
  it("is reachable without login and shows the escaped controller", async () => {
    const { app } = await makeApp(legalEnv);
    const res = await app.inject({ url: "/datenschutz" });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<h1>Datenschutzhinweis</h1>");
    expect(res.body).toContain("Erika &#60;Muster&#62;<br>\nc/o Beispiel &#38; Co<br>\nMusterstraße 1<br>\n12345 Musterstadt");
    expect(res.body).not.toContain("<Muster>");
    expect(res.body).toContain('href="mailto:dice@example.org"');
    expect(res.body).toContain('<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex">');
    // Defaults: CrowdSec on, Cloudflare off.
    expect(res.body).toContain("CrowdSec");
    expect(res.body).not.toContain("Cloudflare");
  });

  it("shows CrowdSec and Cloudflare only when switched on", () => {
    const both = datenschutzHtml(legal, { cloudflare: true, crowdsec: true });
    expect(both).toContain("CrowdSec SAS");
    expect(both).toContain("Cloudflare, Inc.");
    const none = datenschutzHtml(legal, { cloudflare: false, crowdsec: false });
    expect(none).not.toContain("CrowdSec");
    expect(none).not.toContain("Cloudflare");
    expect(none).toContain("Hetzner");
  });

  it("uses the configured retention period", () => {
    expect(datenschutzHtml(legal)).toContain("90 Tage nach der letzten Aktivität");
    expect(datenschutzHtml(legal, { cloudflare: false, crowdsec: true, retentionDays: 30 })).toContain("mehr als 30 Tage zurückliegt");
  });

  it("mentions every data category, the rights and the date", () => {
    const html = datenschutzHtml(legal);
    for (const text of [
      "Discord-ID",
      "Benutzername",
      "Anzeigename",
      "Spitzname",
      "Avatar",
      "Raumteilnahme",
      "Würfe",
      "IP-Adresse",
      "Sitzungs-Cookie",
      "7 Tagen",
      "Zuschauer-Link",
      "Reaktionen",
      "localStorage",
      "kein Tracking",
      'href="https://discord.com/privacy"',
      ...[15, 16, 17, 18, 20, 21, 77].map((n) => `Art. ${n} DSGVO`),
      `Stand: ${PRIVACY_UPDATED}`,
    ]) {
      expect(html).toContain(text);
    }
  });

  it.each([
    ["configured", legal],
    ["not configured", null],
  ])("contains no undefined/null text and no external resources (%s)", (_name, value) => {
    const html = datenschutzHtml(value, { cloudflare: true, crowdsec: true });
    expect(html).not.toMatch(/undefined|null|NaN/);
    expect(html).not.toMatch(/<(script|link|img|iframe|object|embed|style)\b|\bstyle=|\bsrc=/i);
    // Only plain links: relative, mailto or https.
    for (const [, href] of html.matchAll(/href="([^"]*)"/g)) expect(href).toMatch(/^(\/|mailto:|https:\/\/)/);
  });
});

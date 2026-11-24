import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/server/config.js";
import { baseEnv, legalEnv } from "./helpers.js";

describe("parseConfig", () => {
  it("accepts a minimal development configuration", () => {
    const config = parseConfig(baseEnv);
    expect(config.port).toBe(3000);
    expect(config.retentionDays).toBe(90);
    expect(config.legal).toBeNull();
    expect(config.trustedProxies).toEqual([]);
  });

  it("fails without DISCORD_GUILD_ID", () => {
    const env = { ...baseEnv, DISCORD_GUILD_ID: undefined };
    expect(() => parseConfig(env)).toThrow(/DISCORD_GUILD_ID/);
    expect(() => parseConfig({ ...env, DISCORD_GUILD_ID: "" })).toThrow(/DISCORD_GUILD_ID/);
  });

  it("requires LEGAL_* in production", () => {
    const production = { ...baseEnv, NODE_ENV: "production" };
    expect(() => parseConfig(production)).toThrow(/LEGAL_NAME[\s\S]*LEGAL_ADDRESS[\s\S]*LEGAL_EMAIL/);
    expect(() => parseConfig({ ...production, ...legalEnv, LEGAL_EMAIL: "" })).toThrow(/LEGAL_EMAIL/);
    expect(parseConfig({ ...production, ...legalEnv }).legal).toEqual({
      name: "Erika <Muster>",
      addressLines: ["c/o Beispiel & Co", "Musterstraße 1", "12345 Musterstadt"],
      email: "dice@example.org",
      note: undefined,
    });
  });

  it("drops empty address lines and treats blank LEGAL_* as missing", () => {
    const production = { ...baseEnv, NODE_ENV: "production", ...legalEnv };
    expect(parseConfig({ ...production, LEGAL_ADDRESS: " a || b |" }).legal?.addressLines).toEqual(["a", "b"]);
    expect(() => parseConfig({ ...production, LEGAL_NAME: "   " })).toThrow(/LEGAL_NAME/);
    expect(() => parseConfig({ ...production, LEGAL_ADDRESS: " | " })).toThrow(/LEGAL_ADDRESS/);
    expect(parseConfig({ ...baseEnv, ...legalEnv, LEGAL_NAME: " " }).legal).toBeNull();
  });

  it("parses lists and rejects invalid entries", () => {
    const config = parseConfig({
      ...baseEnv,
      HOST_DISCORD_IDS: "100000000000000002, 100000000000000003",
      TRUSTED_PROXIES: "10.0.0.1,172.16.0.0/12,::1",
    });
    expect(config.hostDiscordIds).toEqual(["100000000000000002", "100000000000000003"]);
    expect(config.trustedProxies).toEqual(["10.0.0.1", "172.16.0.0/12", "::1"]);
    expect(() => parseConfig({ ...baseEnv, TRUSTED_PROXIES: "proxy.example.org" })).toThrow(/TRUSTED_PROXIES/);
    expect(() => parseConfig({ ...baseEnv, HOST_DISCORD_IDS: "abc" })).toThrow(/HOST_DISCORD_IDS/);
  });

  it("requires SESSION_SECRET (32+ characters) and the Discord application", () => {
    for (const key of ["SESSION_SECRET", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"] as const) {
      expect(() => parseConfig({ ...baseEnv, [key]: undefined })).toThrow(new RegExp(key));
      expect(() => parseConfig({ ...baseEnv, [key]: "" })).toThrow(new RegExp(key));
    }
    expect(() => parseConfig({ ...baseEnv, SESSION_SECRET: "x".repeat(31) })).toThrow(/SESSION_SECRET/);
  });

  it("allows another Discord API or CDN only under NODE_ENV=test", () => {
    const fake = { DISCORD_API_BASE: "http://127.0.0.1:9", DISCORD_CDN_BASE: "http://127.0.0.1:9/" };
    expect(parseConfig({ ...baseEnv, ...fake })).toMatchObject({ discordApiBase: "http://127.0.0.1:9", discordCdnBase: "http://127.0.0.1:9" });
    for (const NODE_ENV of ["development", "production"]) {
      const env = { ...baseEnv, ...legalEnv, NODE_ENV };
      expect(() => parseConfig({ ...env, DISCORD_CDN_BASE: "https://evil.example" })).toThrow(/DISCORD_CDN_BASE: may only be set when NODE_ENV=test/);
      expect(() => parseConfig({ ...env, DISCORD_API_BASE: "https://evil.example/api" })).toThrow(/DISCORD_API_BASE/);
      expect(parseConfig({ ...env, DISCORD_CDN_BASE: "" })).toMatchObject({
        discordApiBase: "https://discord.com/api",
        discordCdnBase: "https://cdn.discordapp.com",
      });
    }
  });

  it("parses the privacy switches", () => {
    expect(parseConfig(baseEnv).privacyServices).toEqual({ cloudflare: false, crowdsec: true });
    expect(parseConfig({ ...baseEnv, PRIVACY_CLOUDFLARE: "true", PRIVACY_CROWDSEC: "false" }).privacyServices).toEqual({ cloudflare: true, crowdsec: false });
    expect(() => parseConfig({ ...baseEnv, PRIVACY_CLOUDFLARE: "yes" })).toThrow(/PRIVACY_CLOUDFLARE/);
  });

  it("requires BASE_URL to be an http(s) URL", () => {
    expect(() => parseConfig({ ...baseEnv, BASE_URL: "dice.example.org" })).toThrow(/BASE_URL/);
  });
});

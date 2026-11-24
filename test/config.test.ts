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

  it("requires BASE_URL to be an http(s) URL", () => {
    expect(() => parseConfig({ ...baseEnv, BASE_URL: "dice.example.org" })).toThrow(/BASE_URL/);
  });
});

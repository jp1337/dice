import { describe, expect, it } from "vitest";
import { robotsTxt } from "../src/server/robots.js";

// Returns the rule of the group that names the given user agent.
function ruleFor(agent: string) {
  const group = robotsTxt.split("\n\n").find((g) => g.split("\n").includes(`User-agent: ${agent}`));
  return group?.split("\n").find((line) => /^(Allow|Disallow):/.test(line));
}

describe("robots.txt", () => {
  it("disallows everything by default", () => {
    expect(robotsTxt.startsWith("User-agent: *\nDisallow: /\n")).toBe(true);
  });

  it("allows search engines and Discord's link preview", () => {
    for (const agent of ["Googlebot", "bingbot", "DuckDuckBot", "Applebot", "YandexBot", "Discordbot"]) {
      expect(ruleFor(agent), agent).toBe("Allow: /");
    }
  });

  it("blocks AI crawlers and training tokens by name", () => {
    for (const agent of ["Google-Extended", "GPTBot", "ClaudeBot", "CCBot", "Applebot-Extended", "PerplexityBot", "meta-externalagent", "Bytespider", "Amazonbot"]) {
      expect(ruleFor(agent), agent).toBe("Disallow: /");
    }
  });

  it("has no sitemap", () => {
    expect(robotsTxt).not.toMatch(/sitemap/i);
  });
});

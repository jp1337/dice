// robots.txt (spec 8.4): everything is disallowed by default. Search engines and Discord's link
// preview fetcher are allowed so they can fetch pages and see the noindex header; AI crawlers and
// AI training tokens are blocked by name. Tokens are taken from each vendor's own documentation
// (checked 2026-11-24); keep the source URL next to every entry when adding or changing one.

// Allowed: a search engine obeys noindex only if it may fetch the page.
export const allowedCrawlers: readonly string[] = [
  "Googlebot", // https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers
  "bingbot", // https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0 , https://blogs.bing.com/webmaster/May-2012/To-crawl-or-not-to-crawl,-that-is-BingBot-s-questi/
  "DuckDuckBot", // https://duckduckgo.com/duckduckgo-help-pages/results/duckduckbot
  "Applebot", // https://support.apple.com/en-us/119829
  "YandexBot", // https://yandex.com/support/webmaster/en/robot-workings/check-yandex-robots
  "Discordbot", // link previews (spec 10.2): https://support.discord.com/hc/en-us/articles/42500550752919-About-Discord-Link-Previews-and-the-Discordbot
];

// Blocked by name, even though the default group already disallows them.
export const blockedAiCrawlers: readonly string[] = [
  // https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers
  "Google-Extended",
  "Google-CloudVertexBot",
  // https://developers.openai.com/api/docs/bots
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  // https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  // https://docs.perplexity.ai/guides/bots
  "PerplexityBot",
  "Perplexity-User",
  // https://commoncrawl.org/ccbot
  "CCBot",
  // https://support.apple.com/en-us/119829
  "Applebot-Extended",
  // https://developers.facebook.com/docs/sharing/webmasters/web-crawlers
  "meta-externalagent",
  "meta-externalfetcher",
  "meta-webindexer",
  // https://developer.amazon.com/amazonbot
  "Amazonbot",
  "Amzn-SearchBot",
  "Amzn-User",
  // https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot
  "DuckAssistBot",
  // ByteDance publishes no reachable crawler documentation; the token is the one in the user agent
  // string, which links to https://zhanzhang.toutiao.com/
  "Bytespider",
];

const group = (agents: readonly string[], rule: string) =>
  agents.map((agent) => `User-agent: ${agent}`).join("\n") + `\n${rule}\n`;

export const robotsTxt = [
  group(["*"], "Disallow: /"),
  group(allowedCrawlers, "Allow: /"),
  group(blockedAiCrawlers, "Disallow: /"),
].join("\n");

// Configuration from environment variables (spec 11). parseConfig is pure so it can be tested.
import { z } from "zod";

// `KEY=` (or only whitespace) in an env file means "not set".
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), schema.optional());

const snowflake = z.string().regex(/^\d{17,20}$/, "must be a Discord ID (17 to 20 digits)");
const flag = (fallback: boolean) =>
  optional(z.enum(["true", "false"]).transform((value) => value === "true")).transform((value) => value ?? fallback);

// BASE_URL is written into HTML (og:image) and the CSP, so it must be a plain origin. The URL parser
// lets quotes, "&" and ";" through in host names; only a-z, digits, "." and "-" are accepted here.
function baseUrlProblem(url: URL, nodeEnv: string) {
  if (url.protocol !== "https:" && !(url.protocol === "http:" && nodeEnv !== "production")) return "must use https";
  if (url.username || url.password) return "must not contain credentials";
  if (url.pathname !== "/" || url.search || url.hash) return "must be an origin only: no path, query or fragment";
  if (!/^[a-z0-9.-]+$/.test(url.hostname)) return "host may only contain a-z, 0-9, '.' and '-'";
  return null;
}

const DISCORD_API = "https://discord.com/api";
const DISCORD_CDN = "https://cdn.discordapp.com"; // the only avatar host allowed outside tests (spec 5.1)
const list = <T extends z.ZodType<string, string>>(item: T) =>
  z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item));

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    BASE_URL: z.url({ protocol: /^https?$/ }),
    DATABASE_URL: z.string().min(1),
    SESSION_SECRET: z.string().min(32),
    DISCORD_CLIENT_ID: snowflake,
    DISCORD_CLIENT_SECRET: z.string().min(1),
    DISCORD_GUILD_ID: snowflake,
    // Only for tests, which point them at a local fake Discord. Refused in any other NODE_ENV below,
    // so a stray value can never send the client secret or avatar downloads to another host.
    DISCORD_API_BASE: optional(z.url()).transform((value) => value ?? DISCORD_API),
    DISCORD_CDN_BASE: optional(z.url()).transform((value) => value ?? DISCORD_CDN),
    HOST_DISCORD_IDS: list(snowflake),
    TRUSTED_PROXIES: list(z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()])),
    LEGAL_NAME: optional(z.string().trim()),
    // Lines separated by "|"; empty lines are dropped, no lines at all counts as not set.
    LEGAL_ADDRESS: optional(
      z.string().transform((value) => {
        const lines = value.split("|").map((line) => line.trim()).filter(Boolean);
        return lines.length > 0 ? lines : undefined;
      }),
    ),
    LEGAL_EMAIL: optional(z.string().trim().pipe(z.email())),
    LEGAL_NOTE: optional(z.string().trim()),
    RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
    // Only switch sections of the privacy notice on and off (spec 9.2).
    PRIVACY_CLOUDFLARE: flag(false),
    PRIVACY_CROWDSEC: flag(true),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "test") {
      if (env.DISCORD_API_BASE !== DISCORD_API) ctx.addIssue({ code: "custom", path: ["DISCORD_API_BASE"], message: "may only be set when NODE_ENV=test" });
      if (env.DISCORD_CDN_BASE !== DISCORD_CDN) ctx.addIssue({ code: "custom", path: ["DISCORD_CDN_BASE"], message: "may only be set when NODE_ENV=test" });
    }
    const problem = URL.canParse(env.BASE_URL) && baseUrlProblem(new URL(env.BASE_URL), env.NODE_ENV);
    if (problem) ctx.addIssue({ code: "custom", path: ["BASE_URL"], message: problem });
    if (env.NODE_ENV !== "production") return;
    for (const key of ["LEGAL_NAME", "LEGAL_ADDRESS", "LEGAL_EMAIL"] as const) {
      if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "is required in production" });
    }
  });

export type Legal = { name: string; addressLines: string[]; email: string; note: string | undefined };

export function parseConfig(env: Record<string, string | undefined>) {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = result.data;
  const legal: Legal | null =
    e.LEGAL_NAME && e.LEGAL_ADDRESS && e.LEGAL_EMAIL
      ? {
          name: e.LEGAL_NAME,
          addressLines: e.LEGAL_ADDRESS,
          email: e.LEGAL_EMAIL,
          note: e.LEGAL_NOTE,
        }
      : null; // only possible outside production; the pages then say "nicht konfiguriert"
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    baseUrl: new URL(e.BASE_URL),
    databaseUrl: e.DATABASE_URL,
    sessionSecret: e.SESSION_SECRET,
    discordClientId: e.DISCORD_CLIENT_ID,
    discordClientSecret: e.DISCORD_CLIENT_SECRET,
    discordGuildId: e.DISCORD_GUILD_ID,
    discordApiBase: e.DISCORD_API_BASE.replace(/\/+$/, ""),
    discordCdnBase: e.DISCORD_CDN_BASE.replace(/\/+$/, ""),
    hostDiscordIds: e.HOST_DISCORD_IDS,
    trustedProxies: e.TRUSTED_PROXIES,
    legal,
    retentionDays: e.RETENTION_DAYS,
    privacyServices: { cloudflare: e.PRIVACY_CLOUDFLARE, crowdsec: e.PRIVACY_CROWDSEC },
  };
}

export type Config = ReturnType<typeof parseConfig>;

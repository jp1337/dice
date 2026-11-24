// Configuration from environment variables (spec 11). parseConfig is pure so it can be tested.
import { z } from "zod";

// `KEY=` (or only whitespace) in an env file means "not set".
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), schema.optional());

const snowflake = z.string().regex(/^\d{17,20}$/, "must be a Discord ID (17 to 20 digits)");
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
    // Used from step 2 (Discord login) on.
    SESSION_SECRET: optional(z.string().min(32)),
    DISCORD_CLIENT_ID: optional(z.string()),
    DISCORD_CLIENT_SECRET: optional(z.string()),
    DISCORD_GUILD_ID: snowflake,
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
  })
  .superRefine((env, ctx) => {
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
    hostDiscordIds: e.HOST_DISCORD_IDS,
    trustedProxies: e.TRUSTED_PROXIES,
    legal,
    retentionDays: e.RETENTION_DAYS,
  };
}

export type Config = ReturnType<typeof parseConfig>;

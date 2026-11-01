import { z } from "zod";

const required = (name: string) => ({
  error: (issue: { input?: unknown }) => (issue.input === undefined ? `${name} is required` : undefined),
});

const probability = z.coerce.number().min(0).max(1);

const EnvSchema = z.object({
  SLACK_BOT_TOKEN: z.string(required("SLACK_BOT_TOKEN")).startsWith("xoxb-", 'must start with "xoxb-"'),
  SLACK_APP_TOKEN: z.string(required("SLACK_APP_TOKEN")).startsWith("xapp-", 'must start with "xapp-"'),
  SLACK_USER_TOKEN: z.string().startsWith("xoxp-", 'must start with "xoxp-"').optional(),
  TYPESAFE_API_KEY: z.string(required("TYPESAFE_API_KEY")).min(1),
  TYPESAFE_BASE_URL: z.url().optional(),
  TYPESAFE_MODEL: z.string().min(1).default("jev-latest"),
  TYPESAFE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  TYPESAFE_COMPRESSION: z.enum(["auto", "zstd", "off"]).default("auto"),
  REPLY_THRESHOLD: probability.default(0.75),
  PARENT_THRESHOLD: probability.default(0.6),
  CONTEXT_MESSAGES: z.coerce.number().int().min(1).max(100).default(20),
  CONTEXT_MAX_AGE_MINUTES: z.coerce.number().positive().default(120),
  USER_COOLDOWN_MINUTES: z.coerce.number().min(0).default(10),
  NUDGE_DELAY_SECONDS: z.coerce.number().min(0).max(120).default(0),
  DATA_DIR: z.string().min(1).default("data"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type LogLevelName = z.infer<typeof EnvSchema>["LOG_LEVEL"];

export interface Config {
  slack: {
    botToken: string;
    appToken: string;
    /** A workspace admin's user token; when set, Move deletes the original. */
    userToken: string | undefined;
  };
  decision: {
    apiKey: string;
    baseURL: string | undefined;
    model: string;
    timeoutMs: number;
    /** `undefined` lets the SDK pick (zstd where the runtime supports it). */
    compression: "zstd" | false | undefined;
  };
  detection: {
    replyThreshold: number;
    parentThreshold: number;
    contextMessages: number;
    contextMaxAgeMs: number;
  };
  userCooldownMs: number;
  /** Quiet time after a follow-up before nudging, so a burst of messages gets one nudge. */
  nudgeDelayMs: number;
  /** Where the bot keeps the one thing it persists: who has turned nudges off. */
  dataDir: string;
  logLevel: LogLevelName;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat `KEY=` (common in .env files and docker env_file) the same as an unset variable.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ""));
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const key = issue.path.join(".");
      return issue.message.startsWith(key) ? `  - ${issue.message}` : `  - ${key}: ${issue.message}`;
    });
    throw new ConfigError(
      `Invalid configuration:\n${problems.join("\n")}\n\nCopy .env.example to .env and fill it in (see README.md).`,
    );
  }
  const e = parsed.data;
  return {
    slack: { botToken: e.SLACK_BOT_TOKEN, appToken: e.SLACK_APP_TOKEN, userToken: e.SLACK_USER_TOKEN },
    decision: {
      apiKey: e.TYPESAFE_API_KEY,
      baseURL: e.TYPESAFE_BASE_URL,
      model: e.TYPESAFE_MODEL,
      timeoutMs: e.TYPESAFE_TIMEOUT_MS,
      compression: e.TYPESAFE_COMPRESSION === "auto" ? undefined : e.TYPESAFE_COMPRESSION === "zstd" ? "zstd" : false,
    },
    detection: {
      replyThreshold: e.REPLY_THRESHOLD,
      parentThreshold: e.PARENT_THRESHOLD,
      contextMessages: e.CONTEXT_MESSAGES,
      contextMaxAgeMs: e.CONTEXT_MAX_AGE_MINUTES * 60_000,
    },
    userCooldownMs: e.USER_COOLDOWN_MINUTES * 60_000,
    nudgeDelayMs: e.NUDGE_DELAY_SECONDS * 1000,
    dataDir: e.DATA_DIR,
    logLevel: e.LOG_LEVEL,
  };
}

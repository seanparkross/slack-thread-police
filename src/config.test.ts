import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const minimal = {
  SLACK_BOT_TOKEN: "xoxb-123",
  SLACK_APP_TOKEN: "xapp-456",
  TYPESAFE_API_KEY: "ts-key",
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig(minimal)).toEqual({
      slack: { botToken: "xoxb-123", appToken: "xapp-456", userToken: undefined },
      decision: { apiKey: "ts-key", baseURL: undefined, model: "jev-latest", timeoutMs: 10_000, compression: undefined },
      detection: { replyThreshold: 0.75, parentThreshold: 0.6, contextMessages: 20, contextMaxAgeMs: 120 * 60_000 },
      userCooldownMs: 10 * 60_000,
      nudgeDelayMs: 0,
      dataDir: "data",
      logLevel: "info",
    });
  });

  it("parses overrides from strings", () => {
    const config = loadConfig({
      ...minimal,
      SLACK_USER_TOKEN: "xoxp-789",
      TYPESAFE_BASE_URL: "http://llama:8080",
      TYPESAFE_MODEL: "my-local-model",
      TYPESAFE_TIMEOUT_MS: "30000",
      TYPESAFE_COMPRESSION: "off",
      REPLY_THRESHOLD: "0.9",
      PARENT_THRESHOLD: "0.5",
      CONTEXT_MESSAGES: "5",
      CONTEXT_MAX_AGE_MINUTES: "30",
      USER_COOLDOWN_MINUTES: "0",
      NUDGE_DELAY_SECONDS: "5",
      DATA_DIR: "/var/lib/thread-police",
      LOG_LEVEL: "debug",
    });
    expect(config.decision).toEqual({
      apiKey: "ts-key",
      baseURL: "http://llama:8080",
      model: "my-local-model",
      timeoutMs: 30_000,
      compression: false,
    });
    expect(config.detection).toEqual({
      replyThreshold: 0.9,
      parentThreshold: 0.5,
      contextMessages: 5,
      contextMaxAgeMs: 30 * 60_000,
    });
    expect(config.slack.userToken).toBe("xoxp-789");
    expect(config.userCooldownMs).toBe(0);
    expect(config.nudgeDelayMs).toBe(5_000);
    expect(config.dataDir).toBe("/var/lib/thread-police");
    expect(config.logLevel).toBe("debug");
  });

  it("treats empty values as unset", () => {
    const config = loadConfig({ ...minimal, TYPESAFE_BASE_URL: "", REPLY_THRESHOLD: " " });
    expect(config.decision.baseURL).toBeUndefined();
    expect(config.detection.replyThreshold).toBe(0.75);
  });

  it("lists every missing variable in one readable error", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ TYPESAFE_API_KEY: "" })).toThrow(
      /SLACK_BOT_TOKEN is required[\s\S]*SLACK_APP_TOKEN is required[\s\S]*TYPESAFE_API_KEY is required/,
    );
  });

  it.each([
    [{ SLACK_BOT_TOKEN: "xoxp-user-token" }, /SLACK_BOT_TOKEN: must start with "xoxb-"/],
    [{ SLACK_APP_TOKEN: "xoxb-wrong" }, /SLACK_APP_TOKEN: must start with "xapp-"/],
    [{ SLACK_USER_TOKEN: "xoxb-bot-token" }, /SLACK_USER_TOKEN: must start with "xoxp-"/],
    [{ REPLY_THRESHOLD: "1.5" }, /REPLY_THRESHOLD/],
    [{ CONTEXT_MESSAGES: "abc" }, /CONTEXT_MESSAGES/],
    [{ TYPESAFE_BASE_URL: "not a url" }, /TYPESAFE_BASE_URL/],
    [{ LOG_LEVEL: "verbose" }, /LOG_LEVEL/],
    [{ NUDGE_DELAY_SECONDS: "600" }, /NUDGE_DELAY_SECONDS/],
  ])("rejects invalid values %#", (overrides, message) => {
    expect(() => loadConfig({ ...minimal, ...overrides })).toThrow(message);
  });
});

import path from "node:path";
import { App, LogLevel, webApi } from "@slack/bolt";
import { describeError, registerHandlers } from "./app.js";
import { ChannelBuffer } from "./buffer.js";
import { ConfigError, type Config, type LogLevelName, loadConfig } from "./config.js";
import { UserCooldown } from "./cooldown.js";
import { createDecisionClient } from "./decision.js";
import { ThreadDetector } from "./detector.js";
import { PreferenceStore } from "./preferences.js";
import { NudgeStats } from "./stats.js";

const STATS_INTERVAL_MS = 60 * 60_000;

const BOLT_LOG_LEVELS: Record<LogLevelName, LogLevel> = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
};

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

const app = new App({
  token: config.slack.botToken,
  appToken: config.slack.appToken,
  socketMode: true,
  logLevel: BOLT_LOG_LEVELS[config.logLevel],
});

const stats = await NudgeStats.load(path.join(config.dataDir, "stats.json"), Date.now(), (message, error) =>
  app.logger.warn(error === undefined ? message : `${message}: ${describeError(error)}`),
);
const handlers = registerHandlers(app, {
  buffer: new ChannelBuffer(config.detection.contextMessages, config.detection.contextMaxAgeMs),
  detector: new ThreadDetector(createDecisionClient(config), config.detection),
  cooldown: new UserCooldown(config.userCooldownMs),
  prefs: await PreferenceStore.load(path.join(config.dataDir, "preferences.json")),
  stats,
  deleter: config.slack.userToken ? new webApi.WebClient(config.slack.userToken) : undefined,
  nudgeDelayMs: config.nudgeDelayMs,
  contextMessages: config.detection.contextMessages,
  contextMaxAgeMs: config.detection.contextMaxAgeMs,
});

const statsTimer = setInterval(() => {
  const lines = stats.drain();
  if (lines.length > 0) app.logger.info(`Last hour: ${lines.join("; ")}`);
}, STATS_INTERVAL_MS);
statsTimer.unref();

let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.logger.info(`${signal} received, disconnecting from Slack`);
  clearInterval(statsTimer);
  handlers.stop();
  try {
    await app.stop();
  } catch (error) {
    app.logger.error("Error while stopping", error);
  }
  process.exit(0);
}
process.once("SIGTERM", (signal) => void shutdown(signal));
process.once("SIGINT", (signal) => void shutdown(signal));

await app.start();
app.logger.info(
  `Slack Thread Police is running (Socket Mode); Move ${config.slack.userToken ? "deletes" : "keeps"} originals`,
);

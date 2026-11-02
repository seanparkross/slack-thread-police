import type { App, BlockAction, ButtonAction, Logger, webApi } from "@slack/bolt";
import { IGNORE_ACTION, MOVE_ACTION, moveFailedMessage, movedMessage, nudgeMessage, parseMoveTarget } from "./blocks.js";
import type { ChannelBuffer } from "./buffer.js";
import { type Burst, BurstTracker } from "./burst.js";
import { COMMAND, parseJoin, runCommand, statusText } from "./commands.js";
import type { UserCooldown } from "./cooldown.js";
import type { ThreadDetector } from "./detector.js";
import { nudgeSkipReason, type RawMessage, threadParentOf, toChannelMessage } from "./eligibility.js";
import { ADD_CHANNELS_ACTION, homeView, JOIN_ALL_ACTION, JOIN_MODAL, joinModal, pickedChannels } from "./home.js";
import {
  isWorkspaceAdmin,
  type JoinRequest,
  joinChannels,
  joinSummary,
  listChannels,
  resolveJoin,
} from "./join.js";
import { type DeleteClient, moveToThread } from "./move.js";
import type { PreferenceStore } from "./preferences.js";
import type { NudgeStats } from "./stats.js";

export interface HandlerDeps {
  buffer: ChannelBuffer;
  detector: Pick<ThreadDetector, "detect">;
  cooldown: UserCooldown;
  prefs: PreferenceStore;
  stats: NudgeStats;
  /** Admin user-token client that lets Move delete the original; omit for copy-only moves. */
  deleter?: DeleteClient | undefined;
  /** Quiet time after a follow-up before nudging, so a burst of messages gets one nudge. */
  nudgeDelayMs: number;
  /** How far back, and how many messages, to read when seeding a channel the bot hasn't seen yet. */
  contextMessages: number;
  contextMaxAgeMs: number;
}

/** However fast someone keeps typing, nudge within a minute of their first follow-up. */
const BURST_MAX_WAIT_MS = 60_000;
/** After the nudge, later follow-ups keep joining its burst (for Move to sweep up) this long. */
const BURST_TTL_MS = 30 * 60_000;

/** Joining more channels than this says "working on it" first, since Slack allows about 50 joins a minute. */
const SLOW_JOIN = 5;

const NOT_ADMIN =
  "Only workspace admins and owners can add me to channels in bulk. To add me to a channel you're in, run `/invite @Thread Police` there.";
const JOIN_USAGE = `Which channels? For example \`${COMMAND} join #eng #design\`, or \`${COMMAND} join all\` for every public channel.`;
const JOIN_FAILED = ":warning: Something went wrong adding channels. The bot's logs say why.";

/** Message text never goes into logs; errors are reduced to their name and message. */
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function registerHandlers(app: App, deps: HandlerDeps): { stop(): void } {
  const { buffer, detector, cooldown, prefs, stats } = deps;
  const seeding = new Map<string, Promise<void>>();
  /** `channel:parentTs:user` of moves in flight, so a double-click doesn't post two copies. */
  const moving = new Set<string>();

  const bursts = new BurstTracker(
    { delayMs: deps.nudgeDelayMs, maxWaitMs: Math.max(BURST_MAX_WAIT_MS, deps.nudgeDelayMs), ttlMs: BURST_TTL_MS },
    (burst) => void sendNudge(burst),
  );

  async function sendNudge(burst: Burst): Promise<void> {
    const { channel, user, parentTs, messages } = burst;
    // Another nudge may have gone out, or they may have opted out, while this one waited.
    if (cooldown.isCoolingDown(user) || prefs.isOptedOut(user)) {
      bursts.end(channel, user, parentTs);
      return;
    }
    cooldown.start(user);

    let parentPermalink: string | undefined;
    try {
      parentPermalink = (await app.client.chat.getPermalink({ channel, message_ts: parentTs })).permalink;
    } catch {
      // The nudge still makes sense without the link.
    }

    try {
      await app.client.chat.postEphemeral({
        channel,
        user,
        ...nudgeMessage(
          { channel, parentTs, ts: messages },
          { author: user, parentUser: burst.parentUser, parentText: burst.parentText, parentPermalink },
        ),
      });
      stats.record(channel, "nudged");
      app.logger.info(`Nudged ${user} in ${channel} about ${messages.length} message(s)`);
    } catch (error) {
      app.logger.error(`Couldn't send nudge: ${describeError(error)}`);
      cooldown.clear(user);
      bursts.end(channel, user, parentTs);
    }
  }

  async function ensureSeeded(client: webApi.WebClient, channel: string, logger: Logger): Promise<void> {
    if (buffer.isSeeded(channel)) return;
    let pending = seeding.get(channel);
    if (!pending) {
      pending = (async () => {
        const oldest = ((Date.now() - deps.contextMaxAgeMs) / 1000).toFixed(6);
        const history = await client.conversations.history({
          channel,
          oldest,
          limit: Math.min(deps.contextMessages * 2, 200),
        });
        const messages = (history.messages ?? []).flatMap((m: RawMessage) => toChannelMessage(m) ?? []);
        buffer.seed(channel, messages);
      })()
        .catch((error: unknown) => {
          logger.warn(`Couldn't seed channel ${channel} from history: ${describeError(error)}`);
          // Don't retry on every message; live events still fill the buffer from here on.
          buffer.seed(channel, []);
        })
        .finally(() => seeding.delete(channel));
      seeding.set(channel, pending);
    }
    await pending;
  }

  app.event("message", async ({ event, client, logger }) => {
    const channel = event.channel;

    // Keep the buffer in step with edits, deletes and thread replies.
    if (event.subtype === "message_changed") {
      const edited: RawMessage = event.message;
      if (!edited.ts) return;
      if (edited.subtype === "tombstone") buffer.remove(channel, edited.ts);
      else buffer.update(channel, edited.ts, edited.text ?? "", edited.reply_count);
      return;
    }
    if (event.subtype === "message_deleted") {
      buffer.remove(channel, event.deleted_ts);
      return;
    }

    const message: RawMessage = event;
    const parentTs = threadParentOf(message);
    if (parentTs) {
      buffer.noteReply(channel, parentTs);
      return;
    }

    const entry = toChannelMessage(message);
    const skip = nudgeSkipReason(message);
    // In cooldown, only follow-ups that might join an open burst are worth checking.
    const quiet =
      entry !== null &&
      (prefs.isOptedOut(entry.user) || (cooldown.isCoolingDown(entry.user) && !bursts.get(channel, entry.user)));
    if (!entry || skip || quiet) {
      // Not ours to nudge, but it can still be what someone else replies to.
      if (entry) buffer.add(channel, entry);
      if (skip) logger.debug(`Skipping message ${event.ts} in ${channel}: ${skip}`);
      return;
    }

    await ensureSeeded(client, channel, logger);
    const candidates = buffer.candidates(channel, entry.ts);
    buffer.add(channel, entry);

    let detection;
    try {
      detection = await detector.detect(entry, candidates, bursts.get(channel, entry.user));
    } catch (error) {
      logger.warn(`Decision call failed, staying silent: ${describeError(error)}`);
      return;
    }
    if (!detection) return;

    const { suggestion } = detection;
    logger.info(
      `Checked ${entry.ts} in ${channel}: reply ${detection.replyProbability.toFixed(2)}, ` +
        `parent ${detection.picked} ${detection.parentProbability.toFixed(2)} → ` +
        (suggestion ? "follow-up" : `no nudge (${detection.reason})`),
    );
    if (!suggestion) {
      bursts.interrupt(channel, entry.user);
      return;
    }
    // Starting a new burst means a new nudge, so it has to respect the cooldown; joining one doesn't.
    if (!bursts.joins(channel, entry.user, suggestion.parentTs) && cooldown.isCoolingDown(entry.user)) return;
    bursts.add(channel, entry.user, entry.ts, suggestion);
  });

  app.action<BlockAction<ButtonAction>>(MOVE_ACTION, async ({ ack, action, body, client, respond, logger }) => {
    await ack();
    const target = parseMoveTarget(action.value);
    if (!target) {
      await respond({ replace_original: true, ...moveFailedMessage("invalid") });
      return;
    }
    const user = body.user.id;
    const key = `${target.channel}:${target.parentTs}:${user}`;
    if (moving.has(key)) return;
    moving.add(key);
    try {
      // Follow-ups posted after the nudge went out joined its burst; sweep them up too.
      const burst = bursts.end(target.channel, user, target.parentTs);
      const ts = [...new Set([...target.ts, ...(burst?.messages ?? [])])];
      const result = await moveToThread(client, { ...target, ts }, user, deps.deleter);
      if (!result.ok) {
        await respond({ replace_original: true, ...moveFailedMessage(result.reason) });
        return;
      }
      stats.record(target.channel, "moved");
      // Bolt drops our own messages before they reach the event handler, so count the copies here.
      for (let i = 0; i < result.moved; i++) buffer.noteReply(target.channel, target.parentTs);
      for (const error of result.deleteErrors) {
        logger.warn(`Moved, but couldn't delete an original: ${describeError(error)}`);
      }
      await respond({ replace_original: true, ...movedMessage(result) });
    } catch (error) {
      logger.error(`Move failed: ${describeError(error)}`);
      await respond({ replace_original: true, ...moveFailedMessage("error") });
    } finally {
      moving.delete(key);
    }
  });

  app.action<BlockAction<ButtonAction>>(IGNORE_ACTION, async ({ ack, action, body, respond }) => {
    await ack();
    const target = parseMoveTarget(action.value);
    if (target) {
      bursts.end(target.channel, body.user.id, target.parentTs);
      stats.record(target.channel, "ignored");
    }
    await respond({ delete_original: true });
  });

  async function publishHome(client: webApi.WebClient, user: string, notice?: string): Promise<void> {
    const [admin, channels] = await Promise.all([
      isWorkspaceAdmin(client, user).catch(() => false),
      listChannels(client).catch((error: unknown) => {
        app.logger.warn(`Couldn't list channels for the Home tab: ${describeError(error)}`);
        return null;
      }),
    ]);
    await client.views.publish({
      user_id: user,
      view: homeView({ admin, channels, status: statusText(prefs, user), notice }),
    });
  }

  /** Joins the channels `request` names if `user` is an admin, and returns the report for them. */
  async function runJoin(
    client: webApi.WebClient,
    user: string,
    request: JoinRequest,
    onSlowJoin: (count: number) => Promise<unknown>,
  ): Promise<string> {
    if (!(await isWorkspaceAdmin(client, user))) return NOT_ADMIN;
    const resolved = resolveJoin(request, await listChannels(client));
    if (resolved.toJoin.length > SLOW_JOIN) await onSlowJoin(resolved.toJoin.length);
    const outcome = await joinChannels(client, resolved.toJoin);
    for (const { channel, error } of outcome.failed) {
      app.logger.warn(`Couldn't join ${channel.id}: ${describeError(error)}`);
    }
    if (outcome.joined.length > 0) app.logger.info(`${user} added me to ${outcome.joined.length} channel(s)`);
    return joinSummary(resolved, outcome);
  }

  async function joinFromHome(client: webApi.WebClient, user: string, request: JoinRequest): Promise<void> {
    try {
      const report = await runJoin(client, user, request, (count) =>
        publishHome(client, user, `:hourglass_flowing_sand: Joining ${count} channels. This page updates when I'm done.`),
      );
      await publishHome(client, user, report);
    } catch (error) {
      app.logger.error(`Joining channels failed: ${describeError(error)}`);
      await publishHome(client, user, JOIN_FAILED).catch(() => {});
    }
  }

  app.event("app_home_opened", async ({ event, client, logger }) => {
    if (event.tab !== "home") return;
    try {
      await publishHome(client, event.user);
    } catch (error) {
      logger.warn(`Couldn't show the Home tab: ${describeError(error)}`);
    }
  });

  app.action<BlockAction<ButtonAction>>(ADD_CHANNELS_ACTION, async ({ ack, body, client, logger }) => {
    await ack();
    try {
      if (await isWorkspaceAdmin(client, body.user.id)) {
        await client.views.open({ trigger_id: body.trigger_id, view: joinModal() });
      } else {
        await publishHome(client, body.user.id, NOT_ADMIN);
      }
    } catch (error) {
      logger.warn(`Couldn't open the channel picker: ${describeError(error)}`);
    }
  });

  app.view(JOIN_MODAL, async ({ ack, body, view, client }) => {
    await ack();
    await joinFromHome(client, body.user.id, { all: false, ids: pickedChannels(view.state.values), names: [] });
  });

  app.action<BlockAction<ButtonAction>>(JOIN_ALL_ACTION, async ({ ack, body, client }) => {
    await ack();
    await joinFromHome(client, body.user.id, { all: true, ids: [], names: [] });
  });

  app.command(COMMAND, async ({ command, ack, respond, client, logger }) => {
    await ack();
    const join = parseJoin(command.text);
    if (join) {
      if (!join.all && join.ids.length === 0 && join.names.length === 0) {
        await respond({ response_type: "ephemeral", text: JOIN_USAGE });
        return;
      }
      try {
        const report = await runJoin(client, command.user_id, join, (count) =>
          respond({ response_type: "ephemeral", text: `Joining ${count} channels. I'll report back here when I'm done.` }),
        );
        await respond({ response_type: "ephemeral", text: report });
      } catch (error) {
        logger.error(`${COMMAND} join failed: ${describeError(error)}`);
        await respond({ response_type: "ephemeral", text: JOIN_FAILED });
      }
      return;
    }
    try {
      await respond({ response_type: "ephemeral", text: await runCommand(command.text, command.user_id, prefs) });
    } catch (error) {
      logger.error(`${COMMAND} failed: ${describeError(error)}`);
      await respond({ response_type: "ephemeral", text: "Sorry, I couldn't save that. Please try again." });
    }
  });

  return { stop: () => bursts.stop() };
}

import type { JoinRequest } from "./join.js";
import type { PreferenceStore } from "./preferences.js";
import { type Counts, mostlyIgnored, type NudgeStats } from "./stats.js";

export const COMMAND = "/threadpolice";

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
const MAX_SNOOZE_MS = 90 * UNIT_MS.d;

/** "30m", "2h", "3 days", "1w" → milliseconds; null if unreadable, zero, or over 90 days. */
export function parseDuration(text: string): number | null {
  const match = /^(\d+)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)$/i.exec(text.trim());
  if (!match?.[1] || !match[2]) return null;
  const unit = match[2][0]?.toLowerCase() as keyof typeof UNIT_MS;
  const ms = Number(match[1]) * UNIT_MS[unit];
  return ms > 0 && ms <= MAX_SNOOZE_MS ? ms : null;
}

const HELP = [
  "*Thread Police* nudges you privately when a message looks like it belongs in a thread.",
  `• \`${COMMAND} off\`: stop nudging me`,
  `• \`${COMMAND} snooze 2h\`: pause nudges for a while (m, h, d or w, up to 90 days)`,
  `• \`${COMMAND} on\`: turn nudges back on`,
  `• \`${COMMAND} status\`: check whether nudges are on`,
  `• \`${COMMAND} stats\`: how many nudges went out, and how many were moved or ignored`,
  `• \`${COMMAND} join #eng #design\` or \`${COMMAND} join all\`: add me to public channels (workspace admins)`,
].join("\n");

/** A Slack-escaped channel mention, `<#C123|eng>` (the name can be empty). */
const CHANNEL_MENTION = /^<#([A-Z0-9]+)(?:\|[^>]*)?>$/;

/** `join all` or `join #eng #design` as a request; null for every other command. */
export function parseJoin(text: string): JoinRequest | null {
  const [word = "", ...rest] = text.trim().split(/[\s,]+/).filter(Boolean);
  if (word.toLowerCase() !== "join") return null;
  const request: JoinRequest = { all: false, ids: [], names: [] };
  for (const token of rest) {
    const id = CHANNEL_MENTION.exec(token)?.[1];
    if (id) request.ids.push(id);
    else if (token.toLowerCase() === "all") request.all = true;
    else request.names.push(token.replace(/^#/, "").toLowerCase());
  }
  return request;
}

/** Whether `user` is being nudged right now, as one sentence. */
export function statusText(prefs: PreferenceStore, user: string, now = Date.now()): string {
  const status = prefs.status(user, now);
  if (!status.optedOut) return "Nudges are on.";
  return status.until === null ? "Nudges are off." : `Nudges are snoozed until ${slackTime(status.until)}.`;
}

/** Most channels listed by `/threadpolice stats`. */
const MAX_STATS_CHANNELS = 10;

/**
 * Workspace-wide nudge counts for the last 7 and 30 days and all time, then the most nudged of the
 * channels the reader `canSee`.
 */
export function statsText(stats: NudgeStats, canSee: (channel: string) => boolean, now = Date.now()): string {
  const summary = stats.summary(now);
  const { since, week, month, total } = summary;
  if (total.nudged + total.moved + total.ignored === 0) {
    return `No nudges yet. I've been counting since ${slackDate(since)}.`;
  }
  const channels = summary.channels.filter(([channel]) => canSee(channel));
  const lines = [
    `*Nudges* (counting since ${slackDate(since)})`,
    `• Last 7 days: ${countsText(week)}`,
    `• Last 30 days: ${countsText(month)}`,
    `• All time: ${countsText(total)}`,
  ];
  if (channels.length > 0) {
    lines.push("", "*By channel, last 30 days*");
    for (const [channel, counts] of channels.slice(0, MAX_STATS_CHANNELS)) {
      const hint = mostlyIgnored(counts) ? " _Mostly ignored: an admin could raise `REPLY_THRESHOLD`._" : "";
      lines.push(`• <#${channel}>: ${countsText(counts)}${hint}`);
    }
    const more = channels.length - MAX_STATS_CHANNELS;
    if (more > 0) lines.push(`• …and ${more} more`);
  }
  return lines.join("\n");
}

/** "12 nudges: 5 moved (42%), 2 ignored (17%), 5 unanswered". */
function countsText({ nudged, moved, ignored }: Counts): string {
  // A nudge sent just before a window can be answered inside it, so shares can't be exact.
  const share = (count: number) => (nudged > 0 ? ` (${Math.min(100, Math.round((100 * count) / nudged))}%)` : "");
  const unanswered = Math.max(0, nudged - moved - ignored);
  const noun = nudged === 1 ? "nudge" : "nudges";
  return `${nudged} ${noun}: ${moved} moved${share(moved)}, ${ignored} ignored${share(ignored)}, ${unanswered} unanswered`;
}

export interface CommandDeps {
  prefs: PreferenceStore;
  stats: NudgeStats;
  /** Which channels `user` may see listed by `stats`. */
  statsVisibility(user: string): Promise<(channel: string) => boolean>;
}

/** Runs `/threadpolice <text>` for `user` and returns the private reply. */
export async function runCommand(
  text: string,
  user: string,
  { prefs, stats, statsVisibility }: CommandDeps,
  now = Date.now(),
): Promise<string> {
  const [word = "", ...rest] = text.trim().split(/\s+/);
  switch (word.toLowerCase()) {
    case "off":
      await prefs.optOut(user, null);
      return `Got it, I won't nudge you any more. \`${COMMAND} on\` turns nudges back on.`;
    case "on":
      await prefs.optIn(user);
      return "Nudges are back on.";
    case "snooze": {
      const ms = parseDuration(rest.join(" "));
      if (ms === null) return `How long for? For example \`${COMMAND} snooze 2h\` or \`${COMMAND} snooze 3d\` (up to 90 days).`;
      await prefs.optOut(user, now + ms);
      return `Snoozed until ${slackTime(now + ms)}. \`${COMMAND} on\` turns nudges back on sooner.`;
    }
    case "status":
      return statusText(prefs, user, now);
    case "stats":
      return statsText(stats, await statsVisibility(user), now);
    default:
      return HELP;
  }
}

/** Renders in each reader's own timezone. */
function slackTime(ms: number): string {
  return `<!date^${Math.floor(ms / 1000)}^{date_short_pretty} at {time}|${new Date(ms).toISOString()}>`;
}

function slackDate(ms: number): string {
  return `<!date^${Math.floor(ms / 1000)}^{date_short_pretty}|${new Date(ms).toISOString().slice(0, 10)}>`;
}

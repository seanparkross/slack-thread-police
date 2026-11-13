import { z } from "zod";
import { JsonFile } from "./jsonfile.js";

export type Outcome = "nudged" | "moved" | "ignored";
export type Counts = Record<Outcome, number>;

const CountsSchema = z.object({ nudged: z.number(), moved: z.number(), ignored: z.number() });
const FileSchema = z.object({
  since: z.number(),
  total: CountsSchema,
  /** UTC day (`2026-11-03`) → channel id → counts. */
  days: z.record(z.string(), z.record(z.string(), CountsSchema)),
  /** Five-minute slot (ms since the epoch / `SLOT_MS`) → counts, for the last 24 hours. Absent in older files. */
  recent: z.record(z.string(), CountsSchema).default({}),
});
type History = z.infer<typeof FileSchema>;

/** Below this many nudges a channel's ignore rate says too little to act on. */
const MIN_NUDGES_FOR_HINT = 5;
/** Daily counts older than this are dropped; the all-time total keeps them. */
const KEEP_DAYS = 30;
const DAY_MS = 86_400_000;
/** The last hour and last 24 hours are counted in slots this long, so they're accurate to five minutes. */
const SLOT_MS = 300_000;
const SLOTS_PER_HOUR = 3_600_000 / SLOT_MS;
const SLOTS_PER_DAY = DAY_MS / SLOT_MS;

export interface StatsSummary {
  /** When counting started. */
  since: number;
  hour: Counts;
  day: Counts;
  week: Counts;
  month: Counts;
  total: Counts;
  /** The last 30 days per channel, most nudged first. */
  channels: [string, Counts][];
}

/** A channel where most nudges get ignored is a sign the thresholds are too eager there. */
export function mostlyIgnored({ nudged, ignored }: Counts): boolean {
  return nudged >= MIN_NUDGES_FOR_HINT && ignored / nudged >= 0.5;
}

/**
 * Per-channel counts of nudges and what people did with them: channel ids and numbers only, never
 * content or who was nudged. Kept for the hourly log line and, by day, for `/threadpolice stats`.
 */
export class NudgeStats {
  /** Since the last `drain()`. */
  readonly #hour = new Map<string, Counts>();

  private constructor(
    private readonly file: JsonFile | undefined,
    private readonly history: History,
  ) {}

  /**
   * Reads `file` if it exists. Without a file, counts live in memory only. Counts aren't worth
   * stopping the bot over: an unreadable file is set aside and counting starts afresh, with a warning.
   */
  static async load(
    file?: string,
    now = Date.now(),
    warn: (message: string, error?: unknown) => void = () => {},
  ): Promise<NudgeStats> {
    const empty: History = { since: now, total: zero(), days: {}, recent: {} };
    if (!file) return new NudgeStats(undefined, empty);
    const json = new JsonFile(file);
    let data: unknown;
    try {
      data = await json.read();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      data = null;
    }
    if (data !== undefined) {
      const parsed = FileSchema.safeParse(data);
      if (parsed.success) return new NudgeStats(json, parsed.data);
      warn(`${file} isn't a valid stats file; moved it to ${await json.setAside()} and started counting afresh.`);
    }
    // Saved straight away, so the start date survives restarts before the first nudge.
    await json.write(empty).catch((error: unknown) => warn(`Couldn't save ${file}`, error));
    return new NudgeStats(json, empty);
  }

  /** Counts straight away; the returned promise is the save, which only rejects if the file can't be written. */
  record(channel: string, outcome: Outcome, now = Date.now()): Promise<void> {
    let hour = this.#hour.get(channel);
    if (!hour) this.#hour.set(channel, (hour = zero()));
    hour[outcome] += 1;

    const { days, recent, total } = this.history;
    ((days[dayKey(now)] ??= {})[channel] ??= zero())[outcome] += 1;
    const slot = slotOf(now);
    (recent[slot] ??= zero())[outcome] += 1;
    total[outcome] += 1;
    for (const key of Object.keys(recent)) if (Number(key) <= slot - SLOTS_PER_DAY) delete recent[key];
    const oldest = dayKey(now - (KEEP_DAYS - 1) * DAY_MS);
    for (const day of Object.keys(days)) if (day < oldest) delete days[day];
    return this.file?.write(this.history) ?? Promise.resolve();
  }

  /**
   * Counts for the last hour and 24 hours (to the nearest five minutes), the last 7 and 30 days
   * (today included) and since counting started.
   */
  summary(now = Date.now()): StatsSummary {
    const weekStart = dayKey(now - 6 * DAY_MS);
    const monthStart = dayKey(now - (KEEP_DAYS - 1) * DAY_MS);
    const week = zero();
    const month = zero();
    const hour = zero();
    const day = zero();
    const slot = slotOf(now);
    for (const [key, counts] of Object.entries(this.history.recent)) {
      const age = slot - Number(key);
      if (age < 0 || age >= SLOTS_PER_DAY) continue;
      add(day, counts);
      if (age < SLOTS_PER_HOUR) add(hour, counts);
    }
    const channels = new Map<string, Counts>();
    for (const [day, byChannel] of Object.entries(this.history.days)) {
      if (day < monthStart) continue;
      for (const [channel, counts] of Object.entries(byChannel)) {
        add(month, counts);
        if (day >= weekStart) add(week, counts);
        let sum = channels.get(channel);
        if (!sum) channels.set(channel, (sum = zero()));
        add(sum, counts);
      }
    }
    return {
      since: this.history.since,
      hour,
      day,
      week,
      month,
      total: { ...this.history.total },
      channels: [...channels].sort(([, a], [, b]) => b.nudged - a.nudged),
    };
  }

  /** One summary per channel since the last call, then starts counting afresh. */
  drain(): string[] {
    const lines = [...this.#hour].map(([channel, counts]) => {
      const line = `${channel}: ${counts.nudged} nudged, ${counts.moved} moved, ${counts.ignored} ignored`;
      return mostlyIgnored(counts) ? `${line} (mostly ignored; consider raising REPLY_THRESHOLD)` : line;
    });
    this.#hour.clear();
    return lines;
  }
}

function zero(): Counts {
  return { nudged: 0, moved: 0, ignored: 0 };
}

function add(into: Counts, counts: Counts): void {
  into.nudged += counts.nudged;
  into.moved += counts.moved;
  into.ignored += counts.ignored;
}

function slotOf(ms: number): number {
  return Math.floor(ms / SLOT_MS);
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

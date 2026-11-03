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
});
type History = z.infer<typeof FileSchema>;

/** Below this many nudges a channel's ignore rate says too little to act on. */
const MIN_NUDGES_FOR_HINT = 5;
/** Daily counts older than this are dropped; the all-time total keeps them. */
const KEEP_DAYS = 30;
const DAY_MS = 86_400_000;

export interface StatsSummary {
  /** When counting started. */
  since: number;
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

  /** Reads `file` if it exists. Without a file, counts live in memory only. */
  static async load(file?: string, now = Date.now()): Promise<NudgeStats> {
    const empty: History = { since: now, total: zero(), days: {} };
    if (!file) return new NudgeStats(undefined, empty);
    const json = new JsonFile(file);
    const data = await json.read();
    if (data === undefined) return new NudgeStats(json, empty);
    const parsed = FileSchema.safeParse(data);
    if (!parsed.success) throw new Error(`${file} isn't a valid stats file; fix or delete it.`);
    return new NudgeStats(json, parsed.data);
  }

  /** Counts straight away; the returned promise is the save, which only rejects if the file can't be written. */
  record(channel: string, outcome: Outcome, now = Date.now()): Promise<void> {
    let hour = this.#hour.get(channel);
    if (!hour) this.#hour.set(channel, (hour = zero()));
    hour[outcome] += 1;

    const { days, total } = this.history;
    ((days[dayKey(now)] ??= {})[channel] ??= zero())[outcome] += 1;
    total[outcome] += 1;
    const oldest = dayKey(now - (KEEP_DAYS - 1) * DAY_MS);
    for (const day of Object.keys(days)) if (day < oldest) delete days[day];
    return this.file?.write(this.history) ?? Promise.resolve();
  }

  /** Counts for the last 7 and 30 days (today included) and since counting started. */
  summary(now = Date.now()): StatsSummary {
    const weekStart = dayKey(now - 6 * DAY_MS);
    const monthStart = dayKey(now - (KEEP_DAYS - 1) * DAY_MS);
    const week = zero();
    const month = zero();
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

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

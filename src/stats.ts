export type Outcome = "nudged" | "moved" | "ignored";

/** Below this many nudges a channel's ignore rate says too little to act on. */
const MIN_NUDGES_FOR_HINT = 5;

/**
 * Per-channel counts of nudges and what people did with them: numbers only, never content.
 * A channel where most nudges get ignored is a sign the thresholds are too eager there.
 */
export class NudgeStats {
  readonly #channels = new Map<string, Record<Outcome, number>>();

  record(channel: string, outcome: Outcome): void {
    const counts = this.#channels.get(channel) ?? { nudged: 0, moved: 0, ignored: 0 };
    counts[outcome] += 1;
    this.#channels.set(channel, counts);
  }

  /** One summary per channel since the last call, then starts counting afresh. */
  drain(): string[] {
    const lines = [...this.#channels].map(([channel, { nudged, moved, ignored }]) => {
      const line = `${channel}: ${nudged} nudged, ${moved} moved, ${ignored} ignored`;
      return nudged >= MIN_NUDGES_FOR_HINT && ignored / nudged >= 0.5
        ? `${line} (mostly ignored; consider raising REPLY_THRESHOLD)`
        : line;
    });
    this.#channels.clear();
    return lines;
  }
}

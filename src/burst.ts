import type { Suggestion } from "./detector.js";

/** One person's run of follow-ups to the same earlier message, nudged about together. */
export interface Burst {
  channel: string;
  user: string;
  parentTs: string;
  parentUser: string;
  parentText: string;
  /** The person's follow-ups, in the order they arrived. */
  messages: string[];
  /** Whether the nudge has gone out. Later follow-ups still join, so Move can sweep them up. */
  nudged: boolean;
}

export interface BurstTiming {
  /** Quiet time after the latest follow-up before nudging. */
  delayMs: number;
  /** Nudge anyway once a burst is this old, even if messages keep coming. */
  maxWaitMs: number;
  /** How long a nudged burst keeps collecting follow-ups for Move. */
  ttlMs: number;
}

interface Tracked extends Burst {
  startedAt: number;
  timer: NodeJS.Timeout | undefined;
}

/**
 * Groups a person's follow-ups to one message under a single nudge instead of one per message. With a
 * delay it waits for them to stop typing, so the nudge can count them ("Your last 3 messages…"); with
 * none it nudges at once and later follow-ups join silently. In memory only.
 */
export class BurstTracker {
  readonly #bursts = new Map<string, Tracked>();

  constructor(
    private readonly timing: BurstTiming,
    private readonly onReady: (burst: Burst) => void,
  ) {}

  get(channel: string, user: string): Burst | undefined {
    const tracked = this.#bursts.get(key(channel, user));
    return tracked && snapshot(tracked);
  }

  /**
   * Whether a follow-up to `parentTs` belongs to the person's open burst. The model often picks the
   * previous follow-up rather than the original message as the parent, so that counts too.
   */
  joins(channel: string, user: string, parentTs: string): boolean {
    const tracked = this.#bursts.get(key(channel, user));
    return tracked !== undefined && (tracked.parentTs === parentTs || tracked.messages.includes(parentTs));
  }

  add(channel: string, user: string, ts: string, suggestion: Suggestion, now = Date.now()): void {
    const k = key(channel, user);
    const existing = this.#bursts.get(k);
    if (existing && this.joins(channel, user, suggestion.parentTs)) {
      if (!existing.messages.includes(ts)) existing.messages.push(ts);
      if (!existing.nudged) this.#schedule(existing, now);
      return;
    }
    if (existing) {
      // A follow-up to something else: the old burst is done, so nudge about it now.
      clearTimeout(existing.timer);
      this.#bursts.delete(k);
      if (!existing.nudged) this.onReady(snapshot({ ...existing, nudged: true }));
    }
    const burst: Tracked = {
      channel,
      user,
      parentTs: suggestion.parentTs,
      parentUser: suggestion.parentUser,
      parentText: suggestion.parentText,
      messages: [ts],
      nudged: false,
      startedAt: now,
      timer: undefined,
    };
    this.#bursts.set(k, burst);
    this.#schedule(burst, now);
  }

  /** The person posted something unrelated, so nudge now about anything still waiting. */
  interrupt(channel: string, user: string): void {
    const tracked = this.#bursts.get(key(channel, user));
    if (tracked && !tracked.nudged) this.#flush(tracked);
  }

  /** Forget the burst (after Move or Ignore), but only if it's still about `parentTs`. */
  end(channel: string, user: string, parentTs: string): Burst | undefined {
    const k = key(channel, user);
    const tracked = this.#bursts.get(k);
    if (!tracked || tracked.parentTs !== parentTs) return undefined;
    clearTimeout(tracked.timer);
    this.#bursts.delete(k);
    return snapshot(tracked);
  }

  stop(): void {
    for (const tracked of this.#bursts.values()) clearTimeout(tracked.timer);
    this.#bursts.clear();
  }

  #schedule(tracked: Tracked, now: number): void {
    clearTimeout(tracked.timer);
    const wait = Math.max(0, Math.min(this.timing.delayMs, tracked.startedAt + this.timing.maxWaitMs - now));
    tracked.timer = setTimeout(() => this.#flush(tracked), wait);
    tracked.timer.unref?.();
  }

  #flush(tracked: Tracked): void {
    clearTimeout(tracked.timer);
    tracked.nudged = true;
    const k = key(tracked.channel, tracked.user);
    tracked.timer = setTimeout(() => {
      if (this.#bursts.get(k) === tracked) this.#bursts.delete(k);
    }, this.timing.ttlMs);
    tracked.timer.unref?.();
    this.onReady(snapshot(tracked));
  }
}

const key = (channel: string, user: string) => `${channel}:${user}`;

function snapshot({ startedAt: _startedAt, timer: _timer, ...burst }: Tracked): Burst {
  return { ...burst, messages: [...burst.messages] };
}

/** A top-level channel message, as much as detection needs to know about it. */
export interface ChannelMessage {
  ts: string;
  user: string;
  text: string;
  replyCount: number;
}

/**
 * Rolling in-memory window of recent top-level messages per channel, fed from the event stream.
 * Nothing is persisted: a restart starts empty and re-seeds each channel from history on demand.
 */
export class ChannelBuffer {
  readonly #channels = new Map<string, ChannelMessage[]>();
  readonly #seeded = new Set<string>();

  constructor(
    private readonly maxMessages: number,
    private readonly maxAgeMs: number,
  ) {}

  isSeeded(channel: string): boolean {
    return this.#seeded.has(channel);
  }

  seed(channel: string, messages: ChannelMessage[]): void {
    this.#seeded.add(channel);
    for (const message of messages) this.add(channel, message);
  }

  add(channel: string, message: ChannelMessage): void {
    const list = this.#channels.get(channel) ?? [];
    if (list.some((m) => m.ts === message.ts)) return;
    list.push({ ...message });
    list.sort((a, b) => Number(a.ts) - Number(b.ts));
    // Keep some slack beyond maxMessages so deletes don't starve the window.
    if (list.length > this.maxMessages * 2) list.splice(0, list.length - this.maxMessages * 2);
    this.#channels.set(channel, list);
  }

  noteReply(channel: string, parentTs: string): void {
    const parent = this.get(channel, parentTs);
    if (parent) parent.replyCount += 1;
  }

  /** Apply an edit. `replyCount`, when Slack reports one, only ever raises the stored count. */
  update(channel: string, ts: string, text: string, replyCount?: number): void {
    const message = this.get(channel, ts);
    if (!message) return;
    message.text = text;
    if (replyCount !== undefined) message.replyCount = Math.max(message.replyCount, replyCount);
  }

  remove(channel: string, ts: string): void {
    const list = this.#channels.get(channel);
    if (!list) return;
    const index = list.findIndex((m) => m.ts === ts);
    if (index !== -1) list.splice(index, 1);
  }

  get(channel: string, ts: string): ChannelMessage | undefined {
    return this.#channels.get(channel)?.find((m) => m.ts === ts);
  }

  /** Up to `maxMessages` messages posted before `beforeTs` and within the age window, oldest first. */
  candidates(channel: string, beforeTs: string): ChannelMessage[] {
    const before = Number(beforeTs);
    const oldest = before - this.maxAgeMs / 1000;
    const eligible = (this.#channels.get(channel) ?? []).filter((m) => {
      const ts = Number(m.ts);
      return ts < before && ts >= oldest;
    });
    return eligible.slice(-this.maxMessages).map((m) => ({ ...m }));
  }
}

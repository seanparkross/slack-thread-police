import type { ChannelMessage } from "./buffer.js";

/** The fields of a Slack message, from an event or from `conversations.history`, that we read. */
export interface RawMessage {
  ts?: string | undefined;
  subtype?: string | undefined;
  user?: string | undefined;
  bot_id?: string | undefined;
  text?: string | undefined;
  thread_ts?: string | undefined;
  files?: unknown[] | undefined;
  reply_count?: number | undefined;
  /** On "also send to channel" replies (`thread_broadcast`): the thread's parent message. */
  root?: { ts?: string | undefined } | undefined;
}

export type SkipReason = "subtype" | "bot" | "thread_reply" | "no_user" | "no_text" | "files" | "broadcast";

/** Subtypes that are still someone's message (and so can be a parent), as opposed to system notices. */
const PARENT_SUBTYPES = new Set<string | undefined>([undefined, "bot_message", "file_share", "me_message"]);

const BROADCAST = /<!(?:channel|here|everyone)(?:\|[^>]*)?>/;

export function isTopLevel(message: RawMessage): boolean {
  return message.thread_ts === undefined || message.thread_ts === message.ts;
}

/** The parent's ts when the message is a thread reply (including "also send to channel"). */
export function threadParentOf(message: RawMessage): string | undefined {
  // Slack's types make thread_ts optional on broadcasts; the root message names the parent too.
  if (message.subtype === "thread_broadcast") return message.thread_ts ?? message.root?.ts;
  return isTopLevel(message) ? undefined : message.thread_ts;
}

/** The message as a buffer entry, or null when it can't be anyone's parent. */
export function toChannelMessage(message: RawMessage): ChannelMessage | null {
  if (!message.ts || !isTopLevel(message) || !PARENT_SUBTYPES.has(message.subtype)) return null;
  if (!message.user || !message.text?.trim()) return null;
  return { ts: message.ts, user: message.user, text: message.text, replyCount: message.reply_count ?? 0 };
}

/** Why a new message shouldn't be checked for a nudge, or null when it should be. */
export function nudgeSkipReason(message: RawMessage): SkipReason | null {
  if (message.subtype !== undefined) return "subtype";
  if (message.bot_id !== undefined) return "bot";
  if (!isTopLevel(message)) return "thread_reply";
  if (!message.user) return "no_user";
  if (!message.text?.trim()) return "no_text";
  if (message.files && message.files.length > 0) return "files";
  if (BROADCAST.test(message.text)) return "broadcast";
  return null;
}

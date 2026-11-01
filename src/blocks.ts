import type { types } from "@slack/bolt";
import { z } from "zod";

export const MOVE_ACTION = "move_to_thread";
export const IGNORE_ACTION = "ignore_suggestion";

/** Ids only: the button value never carries message content. */
export interface MoveTarget {
  channel: string;
  parentTs: string;
  /** The follow-ups to move. */
  ts: string[];
}

/** Slack caps button values at 2,000 characters; this many ids fit with room to spare. */
const MAX_TS_IN_VALUE = 40;

const MoveTargetSchema = z.object({
  channel: z.string().min(1),
  parentTs: z.string().min(1),
  ts: z.array(z.string().min(1)).min(1).max(MAX_TS_IN_VALUE),
});

export function parseMoveTarget(value: string | undefined): MoveTarget | null {
  if (!value) return null;
  try {
    const parsed = MoveTargetSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

interface SlackMessage {
  text: string;
  blocks: types.KnownBlock[];
}

const SNIPPET_CHARS = 80;

/** A one-line taste of a message for the nudge: whitespace flattened, cut at a word, then "…". */
export function snippet(text: string, max = SNIPPET_CHARS): string {
  const flat = text.replace(/```/g, "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  let cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  if (space > max * 0.6) cut = cut.slice(0, space);
  // Don't leave half a <@U123> mention, <url|link> or &amp; entity behind.
  cut = cut.replace(/<[^>]*$/, "").replace(/&[a-z]*$/i, "");
  return `${cut.trimEnd()}…`;
}

export interface NudgeDetails {
  /** The person being nudged. */
  author: string;
  parentUser: string;
  parentText: string;
  parentPermalink?: string | undefined;
}

/** The private "Only visible to you" nudge, for one follow-up or a burst of them. */
export function nudgeMessage(target: MoveTarget, details: NudgeDetails): SlackMessage {
  const { author, parentUser, parentText, parentPermalink } = details;
  const count = target.ts.length;
  const own = parentUser === author;
  const message = parentPermalink ? `<${parentPermalink}|message>` : "message";
  const whose = own ? `your earlier ${message}` : `<@${parentUser}>'s ${message}`;
  const lead =
    count === 1
      ? `This looks like a ${own ? "follow-up" : "reply"} to ${whose}`
      : `Your last ${count} messages look like ${own ? "follow-ups" : "replies"} to ${whose}`;
  const quote = snippet(parentText);
  // The nudge can't be edited later, so say up front that Move also takes follow-ups posted after it.
  const ask = count === 1 ? "Move it, and any follow-ups, into the thread?" : "Move them, and any more follow-ups, into the thread?";
  const value = JSON.stringify({ ...target, ts: target.ts.slice(0, MAX_TS_IN_VALUE) });
  return {
    text: `${lead}.`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `:thread: ${lead}${quote ? `:\n> ${quote}` : "."}\n${ask}` },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: MOVE_ACTION,
            style: "primary",
            text: { type: "plain_text", text: "Move to thread" },
            value,
          },
          { type: "button", action_id: IGNORE_ACTION, text: { type: "plain_text", text: "Ignore" }, value },
        ],
      },
    ],
  };
}

export interface MovedSummary {
  moved: number;
  deleted: number;
  skipped: number;
  permalink: string | undefined;
}

/** Replaces the nudge once the copies are in the thread. */
export function movedMessage({ moved, deleted, skipped, permalink }: MovedSummary): SlackMessage {
  const what = moved === 1 ? "Moved" : `Moved ${moved} messages`;
  let status: string;
  if (deleted === moved) status = `${what} to the thread.`;
  else if (deleted === 0) status = `${what} — you can now delete your ${moved === 1 ? "original" : "originals"}.`;
  else status = `${what} to the thread. ${moved - deleted} of the originals couldn't be removed, so please delete those yourself.`;
  if (skipped > 0) {
    status += ` ${skipped === 1 ? "1 message was" : `${skipped} messages were`} left in place (already deleted, or with replies of their own).`;
  }
  const link = permalink ? ` <${permalink}|View it in the thread>` : "";
  const text = `:white_check_mark: ${status}${link}`;
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

export type MoveFailure = "not_found" | "not_author" | "has_replies" | "parent_not_found" | "invalid" | "error";

const FAILURE_TEXT: Record<MoveFailure, string> = {
  not_found: "I couldn't find that message any more. It may have been deleted already.",
  not_author: "Only the person who wrote that message can move it.",
  has_replies: "That message already has replies in its own thread, so I've left it where it is.",
  parent_not_found: "The message it replies to has been deleted, so there's no thread to move it into.",
  invalid: "That button has expired. Please move the message by hand.",
  error: "Something went wrong moving that message. Please move it by hand.",
};

export function moveFailedMessage(reason: MoveFailure): SlackMessage {
  const text = `:warning: ${FAILURE_TEXT[reason]}`;
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

/** Attached to the copy posted into the thread. */
export const MOVED_CONTEXT: types.ContextBlock = {
  type: "context",
  elements: [{ type: "mrkdwn", text: "Moved from the channel by Thread Police" }],
};

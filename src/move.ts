import type { types, webApi } from "@slack/bolt";
import { MOVED_CONTEXT, type MovedSummary, type MoveTarget } from "./blocks.js";

export type MoveClient = Pick<webApi.WebClient, "conversations" | "users" | "chat">;

/** A client authenticated with an admin's user token, used only to delete originals. */
export type DeleteClient = { chat: Pick<webApi.WebClient["chat"], "delete"> };

export type MoveRefusal = "not_found" | "not_author" | "has_replies" | "parent_not_found";

export interface MoveOutcome extends MovedSummary {
  ok: true;
  /** Why each failed delete failed, when a delete client was given. */
  deleteErrors: unknown[];
}

export type MoveResult = MoveOutcome | { ok: false; reason: MoveRefusal };

type HistoryMessage = NonNullable<
  Awaited<ReturnType<webApi.WebClient["conversations"]["history"]>>["messages"]
>[number];

const SECTION_TEXT_LIMIT = 3000;
/** One page of history; a burst of follow-ups is far smaller. */
const HISTORY_LIMIT = 100;

/**
 * Copy-based move: a bot token can neither post as a user nor delete their message, so we repost
 * each message into the thread under their name and avatar (`chat:write.customize`). With
 * `deleter` (a workspace admin's user token, see `SLACK_USER_TOKEN`) the originals are then
 * deleted; without it, the person deletes them themselves.
 *
 * Messages that are gone, aren't the clicker's, or have their own thread replies are left alone;
 * the move is refused only when none of them can be moved, or the parent has been deleted.
 *
 * TODO(true move): add opt-in user-token OAuth (`chat:write` as a user scope, tokens stored per
 * user). With each person's own token, Move can post into the thread *as* them, without the APP
 * badge, and delete their original without needing an admin token. Fall back to this copy for
 * people who haven't opted in.
 */
export async function moveToThread(
  client: MoveClient,
  target: MoveTarget,
  actingUser: string,
  deleter?: DeleteClient,
): Promise<MoveResult> {
  const { channel, parentTs } = target;
  const ts = [...new Set(target.ts)].sort((a, b) => Number(a) - Number(b));
  const first = ts[0];
  const last = ts.at(-1);
  if (first === undefined || last === undefined) return { ok: false, reason: "not_found" };

  const [originals, parent] = await Promise.all([
    fetchRange(client, channel, first, last),
    fetchMessage(client, channel, parentTs),
  ]);

  const movable: { ts: string; message: HistoryMessage }[] = [];
  const refusals = new Set<MoveRefusal>();
  for (const t of ts) {
    const message = originals.get(t);
    if (!message) refusals.add("not_found");
    else if (message.user !== actingUser) refusals.add("not_author");
    // Moving (and especially deleting) a message with its own thread would strand those replies.
    else if ((message.reply_count ?? 0) > 0) refusals.add("has_replies");
    else movable.push({ ts: t, message });
  }
  if (movable.length === 0) return { ok: false, reason: mostRelevant(refusals) };
  if (!parent) return { ok: false, reason: "parent_not_found" };

  const { user } = await client.users.info({ user: actingUser });
  const profile = user?.profile;
  const username = profile?.display_name || profile?.real_name || user?.real_name || user?.name || "Someone";
  const iconUrl = profile?.image_192 ?? profile?.image_72;

  // In order, so the thread reads the way the person wrote it.
  let firstCopy: string | undefined;
  for (const { message } of movable) {
    const posted = await client.chat.postMessage({
      channel,
      thread_ts: parentTs,
      ...copyOf(message),
      username,
      ...(iconUrl && { icon_url: iconUrl }),
    });
    firstCopy ??= posted.ts;
  }

  let permalink: string | undefined;
  if (firstCopy) {
    try {
      permalink = (await client.chat.getPermalink({ channel, message_ts: firstCopy })).permalink;
    } catch {
      // The copies are posted; a missing link only makes the confirmation less useful.
    }
  }

  let deleted = 0;
  const deleteErrors: unknown[] = [];
  if (deleter) {
    for (const { ts: original } of movable) {
      try {
        await deleter.chat.delete({ channel, ts: original });
        deleted += 1;
      } catch (error) {
        // The copy is in the thread either way; the person can still delete the original by hand.
        deleteErrors.push(error);
      }
    }
  }

  return { ok: true, moved: movable.length, deleted, skipped: ts.length - movable.length, permalink, deleteErrors };
}

/** Text plus the original's rich_text blocks, so formatting, mentions and emoji survive. */
function copyOf(message: HistoryMessage): { text: string; blocks: types.KnownBlock[] } {
  const text = message.text ?? "";
  // The generated response types don't line up with the request types, hence the cast.
  const richText = ((message.blocks ?? []) as types.KnownBlock[]).filter((block) => block.type === "rich_text");
  const body: types.KnownBlock[] =
    richText.length > 0 ? richText : [{ type: "section", text: { type: "mrkdwn", text: truncate(text, SECTION_TEXT_LIMIT) } }];
  return { text, blocks: [...body, MOVED_CONTEXT] };
}

/** When nothing could be moved, the reason most worth telling the person. */
function mostRelevant(refusals: Set<MoveRefusal>): MoveRefusal {
  if (refusals.has("has_replies")) return "has_replies";
  if (refusals.has("not_author")) return "not_author";
  return "not_found";
}

/** Live top-level messages between two timestamps (inclusive), by ts. */
async function fetchRange(client: MoveClient, channel: string, oldest: string, latest: string) {
  const history = await client.conversations.history({ channel, oldest, latest, inclusive: true, limit: HISTORY_LIMIT });
  const live = new Map<string, HistoryMessage>();
  for (const message of history.messages ?? []) {
    if (message.ts && message.subtype !== "tombstone") live.set(message.ts, message);
  }
  return live;
}

/** The live message at exactly `ts`, or undefined if it's gone (deleted, or only a tombstone left). */
async function fetchMessage(client: MoveClient, channel: string, ts: string) {
  // `latest` + `inclusive` + `limit: 1` returns the newest message at or before `ts`, which is an
  // older message when this one has been deleted, so check the ts matches.
  const history = await client.conversations.history({ channel, latest: ts, inclusive: true, limit: 1 });
  const message = history.messages?.[0];
  return message && message.ts === ts && message.subtype !== "tombstone" ? message : undefined;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

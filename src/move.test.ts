import { describe, expect, it, vi } from "vitest";
import { MOVED_CONTEXT } from "./blocks.js";
import { type DeleteClient, type MoveClient, moveToThread } from "./move.js";

const PARENT = "1700000000.000100";
const A = "1700000100.000100";
const B = "1700000160.000100";
const C = "1700000220.000100";
const target = (...ts: string[]) => ({ channel: "C1", parentTs: PARENT, ts });

const richText = { type: "rich_text", block_id: "abc", elements: [] };
const parent = { ts: PARENT, user: "U9", text: "the question" };
const mine = (ts: string, extra: Record<string, unknown> = {}) => ({ ts, user: "U1", text: `message ${ts}`, ...extra });

/** A channel's top-level history; conversations.history filters it the way Slack does. */
function fakeClient(messages: Record<string, unknown>[]) {
  const sorted = [...messages].sort((a, b) => Number(b.ts) - Number(a.ts));
  const history = vi.fn(async ({ oldest, latest, limit }: { oldest?: string; latest: string; limit: number }) => ({
    ok: true,
    messages: sorted
      .filter((m) => Number(m.ts) <= Number(latest) && (oldest === undefined || Number(m.ts) >= Number(oldest)))
      .slice(0, limit),
  }));
  let next = 0;
  const postMessage = vi.fn(async (_args: { text: string; blocks: unknown }) => ({
    ok: true,
    ts: `1700000900.00010${next++}`,
  }));
  const client = {
    conversations: { history },
    users: {
      info: vi.fn().mockResolvedValue({
        ok: true,
        user: { name: "ada", profile: { display_name: "Ada", image_192: "https://example.com/ada.png" } },
      }),
    },
    chat: {
      postMessage,
      getPermalink: vi.fn().mockResolvedValue({ ok: true, permalink: "https://example.slack.com/p1" }),
    },
  };
  return { client: client as unknown as MoveClient, postMessage };
}

function fakeDeleter(fail: (ts: string) => boolean = () => false) {
  const del = vi.fn(async ({ ts }: { ts: string }) => {
    if (fail(ts)) throw new Error("An API error occurred: cant_delete_message");
    return { ok: true };
  });
  return { deleter: { chat: { delete: del } } as unknown as DeleteClient, del };
}

describe("moveToThread", () => {
  it("reposts a message into the thread as its author", async () => {
    const { client, postMessage } = fakeClient([parent, mine(A, { text: "yes, ship it", blocks: [richText] })]);

    await expect(moveToThread(client, target(A), "U1")).resolves.toEqual({
      ok: true,
      moved: 1,
      deleted: 0,
      skipped: 0,
      permalink: "https://example.slack.com/p1",
      deleteErrors: [],
    });
    expect(postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: PARENT,
      text: "yes, ship it",
      blocks: [richText, MOVED_CONTEXT],
      username: "Ada",
      icon_url: "https://example.com/ada.png",
    });
  });

  it("moves a burst oldest first and deletes each original after its copy", async () => {
    const { client, postMessage } = fakeClient([parent, mine(A), mine(B), mine(C)]);
    const { deleter, del } = fakeDeleter();

    const result = await moveToThread(client, target(C, A, B), "U1", deleter);

    expect(result).toMatchObject({ ok: true, moved: 3, deleted: 3, skipped: 0 });
    expect(postMessage.mock.calls.map(([args]) => args.text)).toEqual([
      `message ${A}`,
      `message ${B}`,
      `message ${C}`,
    ]);
    expect(del.mock.calls.map(([args]) => args.ts)).toEqual([A, B, C]);
    expect(postMessage.mock.invocationCallOrder.at(-1)).toBeLessThan(del.mock.invocationCallOrder[0]!);
  });

  it("falls back to a section block when a message has no rich text", async () => {
    const { client, postMessage } = fakeClient([parent, mine(A, { text: "plain" })]);
    await moveToThread(client, target(A), "U1");
    expect(postMessage.mock.calls[0]?.[0].blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "plain" } },
      MOVED_CONTEXT,
    ]);
  });

  it("skips messages that are gone, someone else's, or have their own thread", async () => {
    const { client, postMessage } = fakeClient([
      parent,
      mine(A),
      { ts: B, user: "U2", text: "not mine" },
      mine(C, { reply_count: 1 }),
    ]);
    const missing = "1700000300.000100";

    const result = await moveToThread(client, target(A, B, C, missing), "U1");

    expect(result).toMatchObject({ ok: true, moved: 1, skipped: 3 });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("still reports the move when deleting an original fails", async () => {
    const { client } = fakeClient([parent, mine(A), mine(B)]);
    const { deleter } = fakeDeleter((ts) => ts === B);

    const result = await moveToThread(client, target(A, B), "U1", deleter);

    expect(result).toMatchObject({ ok: true, moved: 2, deleted: 1 });
    expect(result.ok && result.deleteErrors).toEqual([new Error("An API error occurred: cant_delete_message")]);
  });

  it.each([
    ["not_found", [parent]],
    ["not_author", [parent, { ts: A, user: "U2", text: "not mine" }]],
    ["has_replies", [parent, mine(A, { reply_count: 2 })]],
    ["parent_not_found", [mine(A)]],
    ["parent_not_found", [{ ...parent, subtype: "tombstone" }, mine(A)]],
  ])("refuses with %s and touches nothing", async (reason, messages) => {
    const { client, postMessage } = fakeClient(messages);
    const { deleter, del } = fakeDeleter();
    await expect(moveToThread(client, target(A), "U1", deleter)).resolves.toEqual({ ok: false, reason });
    expect(postMessage).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("reports the original as not found when history only has an older message", async () => {
    const { client } = fakeClient([parent, mine("1700000050.000100")]);
    await expect(moveToThread(client, target(A), "U1")).resolves.toEqual({ ok: false, reason: "not_found" });
  });
});

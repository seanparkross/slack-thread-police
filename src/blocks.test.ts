import { describe, expect, it } from "vitest";
import { IGNORE_ACTION, MOVE_ACTION, movedMessage, nudgeMessage, parseMoveTarget, snippet } from "./blocks.js";

const target = { channel: "C1", parentTs: "1700000000.000100", ts: ["1700000100.000100"] };
const sectionText = (blocks: ReturnType<typeof nudgeMessage>["blocks"]) =>
  blocks[0]?.type === "section" ? blocks[0].text?.text : undefined;

describe("snippet", () => {
  it("keeps short text whole, with whitespace flattened", () => {
    expect(snippet("Does anyone know\n\nwhen the deploy is?")).toBe("Does anyone know when the deploy is?");
  });

  it("cuts long text at a word and adds an ellipsis", () => {
    const text = "Does anyone know when the staging deploy is scheduled for today, and who is running it this time?";
    const result = snippet(text);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(81);
    expect(text.startsWith(result.slice(0, -1))).toBe(true);
    expect(result.slice(0, -1).endsWith(" ")).toBe(false);
  });

  it("never leaves half a mention, link or entity behind", () => {
    expect(snippet("abcdefghij <@U0123456789>", 15)).toBe("abcdefghij…");
    expect(snippet("abcdefghij &amp; more text", 15)).toBe("abcdefghij…");
  });
});

describe("nudgeMessage", () => {
  const base = { author: "U1", parentText: "Does anyone know when the deploy is?" };

  it("names the parent's author for a reply to someone else", () => {
    const { text, blocks } = nudgeMessage(target, { ...base, parentUser: "U9", parentPermalink: "https://x/p" });
    expect(text).toMatch(/^This looks like a reply to <@U9>'s <https:\/\/x\/p\|message>\./);
    expect(sectionText(blocks)).toContain("\n> Does anyone know when the deploy is?");
  });

  it("calls it a follow-up when the parent is the author's own message", () => {
    expect(nudgeMessage(target, { ...base, parentUser: "U1" }).text).toMatch(
      /^This looks like a follow-up to your earlier message\./,
    );
  });

  it("counts a burst of follow-ups", () => {
    const burst = { ...target, ts: ["1", "2", "3"] };
    expect(nudgeMessage(burst, { ...base, parentUser: "U1" }).text).toMatch(
      /^Your last 3 messages look like follow-ups to your earlier message\./,
    );
    expect(nudgeMessage(burst, { ...base, parentUser: "U9" }).text).toMatch(
      /^Your last 3 messages look like replies to <@U9>'s message\./,
    );
  });

  it("is just the lead, the quote, the question and the buttons", () => {
    const { text, blocks } = nudgeMessage(target, { ...base, parentUser: "U9" });
    expect(text).toBe("This looks like a reply to <@U9>'s message.");
    expect(sectionText(blocks)).toMatch(/\n> .+\nMove it, and any follow-ups, into the thread\?$/);
    expect(blocks.map((block) => block.type)).toEqual(["section", "actions"]);
  });

  it("says Move takes later follow-ups too, since the nudge can't be updated", () => {
    const burst = { ...target, ts: ["1", "2"] };
    expect(sectionText(nudgeMessage(burst, { ...base, parentUser: "U9" }).blocks)).toMatch(
      /\nMove them, and any more follow-ups, into the thread\?$/,
    );
  });

  it("puts only ids in both buttons' value, and they round-trip", () => {
    const { blocks } = nudgeMessage(target, { ...base, parentUser: "U9" });
    const actions = blocks.find((block) => block.type === "actions");
    const elements = actions?.type === "actions" ? actions.elements : [];
    const values = elements.map((e) => ("action_id" in e && "value" in e ? [e.action_id, e.value] : []));
    expect(values.map(([id]) => id)).toEqual([MOVE_ACTION, IGNORE_ACTION]);
    for (const [, value] of values) {
      expect(JSON.parse(value ?? "null")).toEqual(target);
      expect(parseMoveTarget(value)).toEqual(target);
    }
  });
});

describe("parseMoveTarget", () => {
  it("rejects malformed values", () => {
    expect(parseMoveTarget(undefined)).toBeNull();
    expect(parseMoveTarget("not json")).toBeNull();
    expect(parseMoveTarget(JSON.stringify({ channel: "C1", parentTs: "1" }))).toBeNull();
    expect(parseMoveTarget(JSON.stringify({ ...target, ts: [] }))).toBeNull();
  });
});

describe("movedMessage", () => {
  const link = "https://x/p";

  it("says moved when every original was removed", () => {
    expect(movedMessage({ moved: 1, deleted: 1, skipped: 0, permalink: link }).text).toBe(
      ":white_check_mark: Moved to the thread. <https://x/p|View it in the thread>",
    );
    expect(movedMessage({ moved: 3, deleted: 3, skipped: 0, permalink: undefined }).text).toBe(
      ":white_check_mark: Moved 3 messages to the thread.",
    );
  });

  it("asks the person to delete originals that weren't removed", () => {
    expect(movedMessage({ moved: 1, deleted: 0, skipped: 0, permalink: undefined }).text).toBe(
      ":white_check_mark: Moved — you can now delete your original.",
    );
    expect(movedMessage({ moved: 2, deleted: 0, skipped: 0, permalink: undefined }).text).toContain(
      "you can now delete your originals",
    );
    expect(movedMessage({ moved: 3, deleted: 2, skipped: 0, permalink: undefined }).text).toContain(
      "1 of the originals couldn't be removed",
    );
  });

  it("says when some messages stayed put", () => {
    expect(movedMessage({ moved: 2, deleted: 2, skipped: 1, permalink: undefined }).text).toContain(
      "1 message was left in place",
    );
  });
});

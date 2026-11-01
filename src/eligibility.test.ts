import { describe, expect, it } from "vitest";
import { nudgeSkipReason, type RawMessage, threadParentOf, toChannelMessage } from "./eligibility.js";

const human = (overrides: Partial<RawMessage> = {}): RawMessage => ({
  ts: "1700000000.000100",
  user: "U1",
  text: "sounds good to me",
  ...overrides,
});

describe("nudgeSkipReason", () => {
  it("accepts a plain top-level message from a person", () => {
    expect(nudgeSkipReason(human())).toBeNull();
    // A thread parent reports thread_ts === ts; it's still top-level.
    expect(nudgeSkipReason(human({ thread_ts: "1700000000.000100" }))).toBeNull();
  });

  it.each<[string, Partial<RawMessage>, string]>([
    ["bot messages", { subtype: "bot_message", bot_id: "B1" }, "subtype"],
    ["apps posting as a bot user", { bot_id: "B1" }, "bot"],
    ["other subtypes", { subtype: "channel_join" }, "subtype"],
    ["file shares", { subtype: "file_share" }, "subtype"],
    ["thread replies", { thread_ts: "1699999999.000100" }, "thread_reply"],
    ["messages without text", { text: "" }, "no_text"],
    ["whitespace-only text", { text: "  \n" }, "no_text"],
    ["messages with files", { files: [{ id: "F1" }] }, "files"],
    ["@channel posts", { text: "<!channel> deploy freeze starts now" }, "broadcast"],
    ["@here posts", { text: "anyone around? <!here>" }, "broadcast"],
    ["@everyone posts", { text: "<!everyone> office closed" }, "broadcast"],
    ["@here with a label", { text: "<!here|here> standup" }, "broadcast"],
    ["messages with no author", { user: undefined }, "no_user"],
  ])("skips %s", (_, overrides, reason) => {
    expect(nudgeSkipReason(human(overrides))).toBe(reason);
  });

  it("doesn't mistake user mentions for broadcasts", () => {
    expect(nudgeSkipReason(human({ text: "<@U2> here you go" }))).toBeNull();
  });
});

describe('"also send to channel" replies', () => {
  const broadcast = human({ subtype: "thread_broadcast", thread_ts: "1699999999.000100" });

  it("are treated as thread replies, never as new channel messages", () => {
    expect(threadParentOf(broadcast)).toBe("1699999999.000100");
    expect(nudgeSkipReason(broadcast)).toBe("subtype");
    expect(toChannelMessage(broadcast)).toBeNull();
  });

  it("still find their parent if Slack leaves out thread_ts", () => {
    const { thread_ts: _, ...withoutThreadTs } = broadcast;
    expect(threadParentOf({ ...withoutThreadTs, root: { ts: "1699999999.000100" } })).toBe("1699999999.000100");
  });

  it("are left out of the history the bot seeds a channel from", () => {
    expect(toChannelMessage({ ...broadcast, reply_count: undefined })).toBeNull();
  });
});

describe("threadParentOf", () => {
  it("returns the parent ts for replies, including broadcasts back to the channel", () => {
    expect(threadParentOf(human({ thread_ts: "1699999999.000100" }))).toBe("1699999999.000100");
    expect(threadParentOf(human({ subtype: "thread_broadcast", thread_ts: "1699999999.000100" }))).toBe(
      "1699999999.000100",
    );
  });

  it("returns undefined for top-level messages", () => {
    expect(threadParentOf(human())).toBeUndefined();
    expect(threadParentOf(human({ thread_ts: "1700000000.000100" }))).toBeUndefined();
  });
});

describe("toChannelMessage", () => {
  it("turns a top-level message into a buffer entry with its reply count", () => {
    expect(toChannelMessage(human({ reply_count: 3 }))).toEqual({
      ts: "1700000000.000100",
      user: "U1",
      text: "sounds good to me",
      replyCount: 3,
    });
  });

  it("keeps messages that can't be nudged but can still be replied to", () => {
    expect(toChannelMessage(human({ text: "<!here> standup in 5" }))).not.toBeNull();
    expect(toChannelMessage(human({ subtype: "bot_message", bot_id: "B1" }))).not.toBeNull();
    expect(toChannelMessage(human({ subtype: "file_share", files: [{}] }))).not.toBeNull();
  });

  it("drops system notices, replies and messages without an author or text", () => {
    expect(toChannelMessage(human({ subtype: "channel_join" }))).toBeNull();
    expect(toChannelMessage(human({ thread_ts: "1699999999.000100" }))).toBeNull();
    expect(toChannelMessage(human({ user: undefined }))).toBeNull();
    expect(toChannelMessage(human({ text: undefined }))).toBeNull();
  });
});

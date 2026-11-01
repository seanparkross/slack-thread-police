import { describe, expect, it } from "vitest";
import { ChannelBuffer, type ChannelMessage } from "./buffer.js";

const msg = (ts: number, overrides: Partial<ChannelMessage> = {}): ChannelMessage => ({
  ts: `${ts}.000100`,
  user: "U1",
  text: `message at ${ts}`,
  replyCount: 0,
  ...overrides,
});

const HOUR = 60 * 60 * 1000;

describe("ChannelBuffer", () => {
  it("returns earlier messages within the age window, oldest first", () => {
    const buffer = new ChannelBuffer(10, HOUR);
    buffer.add("C1", msg(5000));
    buffer.add("C1", msg(1000)); // more than an hour before 5000
    buffer.add("C1", msg(4000));
    buffer.add("C1", msg(6000)); // after the new message

    expect(buffer.candidates("C1", "5500.000100").map((m) => m.ts)).toEqual(["4000.000100", "5000.000100"]);
  });

  it("caps candidates at maxMessages, keeping the most recent", () => {
    const buffer = new ChannelBuffer(2, HOUR);
    for (const ts of [100, 200, 300, 400]) buffer.add("C1", msg(ts));
    expect(buffer.candidates("C1", "500").map((m) => m.ts)).toEqual(["300.000100", "400.000100"]);
  });

  it("keeps channels separate and ignores duplicate ts", () => {
    const buffer = new ChannelBuffer(10, HOUR);
    buffer.add("C1", msg(100));
    buffer.add("C1", msg(100, { text: "duplicate" }));
    buffer.add("C2", msg(200));
    expect(buffer.candidates("C1", "1000")).toEqual([msg(100)]);
    expect(buffer.candidates("C2", "1000")).toEqual([msg(200)]);
  });

  it("tracks seeding and merges seeded history with live messages", () => {
    const buffer = new ChannelBuffer(10, HOUR);
    buffer.add("C1", msg(300));
    expect(buffer.isSeeded("C1")).toBe(false);
    buffer.seed("C1", [msg(100), msg(300)]);
    expect(buffer.isSeeded("C1")).toBe(true);
    expect(buffer.candidates("C1", "1000").map((m) => m.ts)).toEqual(["100.000100", "300.000100"]);
  });

  it("counts replies, applies edits and removes deleted messages", () => {
    const buffer = new ChannelBuffer(10, HOUR);
    buffer.add("C1", msg(100));
    buffer.add("C1", msg(200));

    buffer.noteReply("C1", "100.000100");
    buffer.noteReply("C1", "100.000100");
    buffer.noteReply("C1", "999.000100"); // unknown parent: ignored
    buffer.update("C1", "200.000100", "edited");
    buffer.update("C1", "100.000100", "still here", 1); // a lower reported count never wins
    buffer.remove("C1", "200.000100");

    expect(buffer.candidates("C1", "1000")).toEqual([msg(100, { text: "still here", replyCount: 2 })]);
  });

  it("hands out copies so callers can't mutate the buffer", () => {
    const buffer = new ChannelBuffer(10, HOUR);
    const original = msg(100);
    buffer.add("C1", original);
    original.text = "mutated after add";
    const [candidate] = buffer.candidates("C1", "1000");
    if (candidate) candidate.text = "mutated after read";
    expect(buffer.get("C1", "100.000100")?.text).toBe("message at 100");
  });

  it("bounds memory per channel", () => {
    const buffer = new ChannelBuffer(3, 1000 * HOUR);
    for (let ts = 1; ts <= 20; ts++) buffer.add("C1", msg(ts));
    expect(buffer.get("C1", "1.000100")).toBeUndefined();
    expect(buffer.get("C1", "20.000100")).toBeDefined();
  });
});

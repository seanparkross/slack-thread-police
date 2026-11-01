import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Burst, BurstTracker } from "./burst.js";
import type { Suggestion } from "./detector.js";

const timing = { delayMs: 10_000, maxWaitMs: 60_000, ttlMs: 30 * 60_000 };
const PARENT = "100.0001";
const suggestion = (parentTs = PARENT): Suggestion => ({
  parentTs,
  parentUser: "U1",
  parentText: "the question",
  replyProbability: 0.9,
  parentProbability: 0.9,
});

describe("BurstTracker", () => {
  let ready: Burst[];
  let tracker: BurstTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    ready = [];
    tracker = new BurstTracker(timing, (burst) => ready.push(burst));
  });
  afterEach(() => {
    tracker.stop();
    vi.useRealTimers();
  });

  const add = (ts: string, parentTs = PARENT) => tracker.add("C1", "U1", ts, suggestion(parentTs), Date.now());

  it("nudges once, after the person has been quiet for the delay", () => {
    add("101");
    vi.advanceTimersByTime(9_999);
    expect(ready).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ channel: "C1", user: "U1", parentTs: PARENT, messages: ["101"], nudged: true });
  });

  it("restarts the wait for each follow-up and nudges about all of them together", () => {
    add("101");
    vi.advanceTimersByTime(8_000);
    add("102");
    vi.advanceTimersByTime(8_000);
    add("103");
    vi.advanceTimersByTime(9_999);
    expect(ready).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ready.map((b) => b.messages)).toEqual([["101", "102", "103"]]);
  });

  it("treats a follow-up to the previous follow-up as part of the same burst", () => {
    add("101");
    add("102", "101");
    expect(tracker.joins("C1", "U1", "102")).toBe(true);
    vi.advanceTimersByTime(timing.delayMs);
    expect(ready.map((b) => b.messages)).toEqual([["101", "102"]]);
  });

  it("nudges anyway once the burst hits the maximum wait", () => {
    for (let i = 0; i < 10; i++) {
      add(`10${i}`);
      vi.advanceTimersByTime(9_000);
    }
    expect(ready).toHaveLength(1);
    expect(ready[0]?.messages.length).toBeLessThan(10);
  });

  it("keeps collecting follow-ups after the nudge, for Move to sweep up", () => {
    add("101");
    vi.advanceTimersByTime(timing.delayMs);
    add("102");
    vi.advanceTimersByTime(timing.delayMs);
    expect(ready).toHaveLength(1);
    expect(tracker.get("C1", "U1")?.messages).toEqual(["101", "102"]);
  });

  it("forgets a nudged burst after its time to live", () => {
    add("101");
    vi.advanceTimersByTime(timing.delayMs + timing.ttlMs);
    expect(tracker.get("C1", "U1")).toBeUndefined();
  });

  it("nudges straight away when the person moves on to something unrelated", () => {
    add("101");
    tracker.interrupt("C1", "U1");
    expect(ready.map((b) => b.messages)).toEqual([["101"]]);
    vi.advanceTimersByTime(timing.delayMs);
    expect(ready).toHaveLength(1);
  });

  it("nudges about the old burst when a follow-up to a different message starts a new one", () => {
    add("101");
    add("102", "50.0001");
    expect(ready.map((b) => [b.parentTs, b.messages])).toEqual([[PARENT, ["101"]]]);
    expect(tracker.get("C1", "U1")).toMatchObject({ parentTs: "50.0001", messages: ["102"], nudged: false });
  });

  it("ends a burst only for the parent it's about", () => {
    add("101");
    expect(tracker.end("C1", "U1", "other")).toBeUndefined();
    expect(tracker.end("C1", "U1", PARENT)).toMatchObject({ messages: ["101"] });
    vi.advanceTimersByTime(timing.delayMs);
    expect(ready).toEqual([]);
  });

  it("with no delay, nudges about the first follow-up and lets later ones join silently", () => {
    tracker.stop();
    tracker = new BurstTracker({ ...timing, delayMs: 0 }, (burst) => ready.push(burst));
    add("101");
    vi.advanceTimersByTime(0);
    expect(ready.map((b) => b.messages)).toEqual([["101"]]);
    add("102");
    add("103", "102");
    vi.advanceTimersByTime(timing.maxWaitMs);
    expect(ready).toHaveLength(1);
    expect(tracker.get("C1", "U1")?.messages).toEqual(["101", "102", "103"]);
  });

  it("keeps people and channels apart", () => {
    add("101");
    tracker.add("C1", "U2", "102", suggestion(), Date.now());
    tracker.add("C2", "U1", "103", suggestion(), Date.now());
    vi.advanceTimersByTime(timing.delayMs);
    expect(ready).toHaveLength(3);
  });
});

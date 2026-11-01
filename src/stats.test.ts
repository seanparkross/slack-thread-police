import { describe, expect, it } from "vitest";
import { NudgeStats } from "./stats.js";

describe("NudgeStats", () => {
  it("summarises each channel and starts afresh", () => {
    const stats = new NudgeStats();
    stats.record("C1", "nudged");
    stats.record("C1", "nudged");
    stats.record("C1", "moved");
    stats.record("C2", "nudged");
    expect(stats.drain()).toEqual(["C1: 2 nudged, 1 moved, 0 ignored", "C2: 1 nudged, 0 moved, 0 ignored"]);
    expect(stats.drain()).toEqual([]);
  });

  it("suggests raising the threshold when most nudges in a channel are ignored", () => {
    const stats = new NudgeStats();
    for (let i = 0; i < 6; i++) stats.record("C1", "nudged");
    for (let i = 0; i < 4; i++) stats.record("C1", "ignored");
    expect(stats.drain()[0]).toMatch(/consider raising REPLY_THRESHOLD/);
  });

  it("doesn't read anything into a handful of nudges", () => {
    const stats = new NudgeStats();
    stats.record("C1", "nudged");
    stats.record("C1", "ignored");
    expect(stats.drain()[0]).not.toMatch(/consider/);
  });
});

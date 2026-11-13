import { describe, expect, it } from "vitest";
import { type CommandDeps, parseDuration, parseJoin, runCommand, statsText } from "./commands.js";
import { PreferenceStore } from "./preferences.js";
import { NudgeStats } from "./stats.js";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function inMemory(): Promise<CommandDeps> {
  return {
    prefs: await PreferenceStore.load(),
    stats: await NudgeStats.load(undefined, NOW),
    statsVisibility: async () => everyChannel,
  };
}

const everyChannel = () => true;

describe("parseDuration", () => {
  it.each([
    ["30m", 30 * 60_000],
    ["2h", 2 * HOUR],
    ["2 hours", 2 * HOUR],
    ["3d", 72 * HOUR],
    ["1 week", 168 * HOUR],
    ["90d", 90 * 24 * HOUR],
  ])("reads %s", (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each(["", "soon", "2", "0h", "91d", "-1h", "1y"])("rejects %j", (text) => {
    expect(parseDuration(text)).toBeNull();
  });
});

describe("parseJoin", () => {
  it("reads escaped mentions, plain names and commas", () => {
    expect(parseJoin("join <#C1|eng> #Design, support <#C2|>")).toEqual({
      all: false,
      ids: ["C1", "C2"],
      names: ["design", "support"],
    });
  });

  it("reads `join all`", () => {
    expect(parseJoin("JOIN all")).toEqual({ all: true, ids: [], names: [] });
  });

  it("returns an empty request for a bare `join`, and null for other commands", () => {
    expect(parseJoin(" join ")).toEqual({ all: false, ids: [], names: [] });
    expect(parseJoin("status")).toBeNull();
    expect(parseJoin("")).toBeNull();
  });
});

describe("runCommand", () => {
  it("turns nudges off, reports it, and turns them back on", async () => {
    const deps = await inMemory();
    expect(await runCommand("off", "U1", deps, NOW)).toMatch(/won't nudge you/);
    expect(deps.prefs.isOptedOut("U1", NOW)).toBe(true);
    expect(await runCommand("status", "U1", deps, NOW)).toBe("Nudges are off.");
    expect(await runCommand("ON", "U1", deps, NOW)).toBe("Nudges are back on.");
    expect(await runCommand("status", "U1", deps, NOW)).toBe("Nudges are on.");
  });

  it("snoozes until a time shown in the reader's timezone", async () => {
    const deps = await inMemory();
    const reply = await runCommand("snooze 2h", "U1", deps, NOW);
    expect(reply).toContain(`<!date^${(NOW + 2 * HOUR) / 1000}^`);
    expect(deps.prefs.status("U1", NOW)).toEqual({ optedOut: true, until: NOW + 2 * HOUR });
    expect(deps.prefs.isOptedOut("U1", NOW + 2 * HOUR)).toBe(false);
  });

  it("asks how long when the snooze has no usable duration", async () => {
    const deps = await inMemory();
    expect(await runCommand("snooze", "U1", deps, NOW)).toMatch(/How long for\?/);
    expect(deps.prefs.isOptedOut("U1", NOW)).toBe(false);
  });

  it("reports stats, listing only the channels the caller may see", async () => {
    const deps = await inMemory();
    const asked: string[] = [];
    deps.statsVisibility = async (user) => {
      asked.push(user);
      return (channel) => channel === "C1";
    };
    await deps.stats.record("C1", "nudged", NOW);
    await deps.stats.record("C2", "nudged", NOW);
    const reply = await runCommand("Stats", "U1", deps, NOW);
    expect(asked).toEqual(["U1"]);
    expect(reply).toContain("Last 7 days: 2 nudges: 0 moved (0%)");
    expect(reply).toContain("<#C1>");
    expect(reply).not.toContain("<#C2>");
  });

  it.each(["", "help", "banana"])("shows help for %j", async (text) => {
    expect(await runCommand(text, "U1", await inMemory(), NOW)).toMatch(/\/threadpolice off/);
  });
});

describe("statsText", () => {
  it("says when there's nothing to report yet", async () => {
    const stats = await NudgeStats.load(undefined, NOW);
    expect(statsText(stats, everyChannel, NOW)).toMatch(/^No nudges yet\. I've been counting since <!date\^/);
  });

  it("counts moves and ignores as activity even without nudges", async () => {
    const stats = await NudgeStats.load(undefined, NOW);
    await stats.record("C1", "moved", NOW);
    expect(statsText(stats, everyChannel, NOW)).toContain("Last 7 days: 0 nudges: 1 moved, 0 ignored, 0 unanswered");
  });

  it("leaves out the channel list when the reader can't see any of the channels", async () => {
    const stats = await NudgeStats.load(undefined, NOW);
    await stats.record("C1", "nudged", NOW);
    const text = statsText(stats, () => false, NOW);
    expect(text).toContain("Last 7 days: 1 nudge");
    expect(text).not.toContain("By channel");
  });

  it("totals the last hour, 24 hours, 7 days, 30 days and all time, then each channel", async () => {
    const stats = await NudgeStats.load(undefined, NOW - 60 * DAY);
    await stats.record("C1", "nudged", NOW - 40 * DAY);
    for (let i = 0; i < 4; i++) await stats.record("C1", "nudged", NOW - 10 * DAY);
    await stats.record("C1", "moved", NOW - 10 * DAY);
    await stats.record("C2", "nudged", NOW - 2 * 3_600_000);
    await stats.record("C2", "moved", NOW);
    expect(statsText(stats, everyChannel, NOW).split("\n").slice(1)).toEqual([
      "• Last hour: 0 nudges: 1 moved, 0 ignored, 0 unanswered",
      "• Last 24 hours: 1 nudge: 1 moved (100%), 0 ignored (0%), 0 unanswered",
      "• Last 7 days: 1 nudge: 1 moved (100%), 0 ignored (0%), 0 unanswered",
      "• Last 30 days: 5 nudges: 2 moved (40%), 0 ignored (0%), 3 unanswered",
      "• All time: 6 nudges: 2 moved (33%), 0 ignored (0%), 4 unanswered",
      "",
      "*By channel, last 30 days*",
      "• <#C1>: 4 nudges: 1 moved (25%), 0 ignored (0%), 3 unanswered",
      "• <#C2>: 1 nudge: 1 moved (100%), 0 ignored (0%), 0 unanswered",
    ]);
  });

  it("flags channels where most nudges are ignored", async () => {
    const stats = await NudgeStats.load(undefined, NOW);
    for (let i = 0; i < 6; i++) await stats.record("C1", "nudged", NOW);
    for (let i = 0; i < 4; i++) await stats.record("C1", "ignored", NOW);
    expect(statsText(stats, everyChannel, NOW)).toContain("<#C1>: 6 nudges: 0 moved (0%), 4 ignored (67%), 2 unanswered _Mostly ignored");
  });

  it("lists the ten most nudged channels", async () => {
    const stats = await NudgeStats.load(undefined, NOW);
    for (let c = 1; c <= 12; c++) {
      for (let i = 0; i < c; i++) await stats.record(`C${c}`, "nudged", NOW);
    }
    const text = statsText(stats, everyChannel, NOW);
    expect(text).toContain("• <#C12>: 12 nudges");
    expect(text).toContain("• <#C3>: 3 nudges");
    expect(text).not.toContain("<#C2>");
    expect(text).toMatch(/…and 2 more$/);
  });
});

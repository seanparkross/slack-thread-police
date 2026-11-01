import { describe, expect, it } from "vitest";
import { parseDuration, runCommand } from "./commands.js";
import { PreferenceStore } from "./preferences.js";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

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

describe("runCommand", () => {
  it("turns nudges off, reports it, and turns them back on", async () => {
    const prefs = await PreferenceStore.load();
    expect(await runCommand("off", "U1", prefs, NOW)).toMatch(/won't nudge you/);
    expect(prefs.isOptedOut("U1", NOW)).toBe(true);
    expect(await runCommand("status", "U1", prefs, NOW)).toBe("Nudges are off.");
    expect(await runCommand("ON", "U1", prefs, NOW)).toBe("Nudges are back on.");
    expect(await runCommand("status", "U1", prefs, NOW)).toBe("Nudges are on.");
  });

  it("snoozes until a time shown in the reader's timezone", async () => {
    const prefs = await PreferenceStore.load();
    const reply = await runCommand("snooze 2h", "U1", prefs, NOW);
    expect(reply).toContain(`<!date^${(NOW + 2 * HOUR) / 1000}^`);
    expect(prefs.status("U1", NOW)).toEqual({ optedOut: true, until: NOW + 2 * HOUR });
    expect(prefs.isOptedOut("U1", NOW + 2 * HOUR)).toBe(false);
  });

  it("asks how long when the snooze has no usable duration", async () => {
    const prefs = await PreferenceStore.load();
    expect(await runCommand("snooze", "U1", prefs, NOW)).toMatch(/How long for\?/);
    expect(prefs.isOptedOut("U1", NOW)).toBe(false);
  });

  it.each(["", "help", "banana"])("shows help for %j", async (text) => {
    const prefs = await PreferenceStore.load();
    expect(await runCommand(text, "U1", prefs, NOW)).toMatch(/\/threadpolice off/);
  });
});

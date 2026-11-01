import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PreferenceStore } from "./preferences.js";

describe("PreferenceStore", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "thread-police-"));
    file = path.join(dir, "nested", "preferences.json");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("starts empty when there's no file yet", async () => {
    const prefs = await PreferenceStore.load(file);
    expect(prefs.status("U1")).toEqual({ optedOut: false });
  });

  it("persists opt-outs and snoozes across restarts, as ids and times only", async () => {
    const prefs = await PreferenceStore.load(file);
    await prefs.optOut("U1", null);
    await prefs.optOut("U2", 5_000);

    const reloaded = await PreferenceStore.load(file);
    expect(reloaded.status("U1", 1_000)).toEqual({ optedOut: true, until: null });
    expect(reloaded.status("U2", 1_000)).toEqual({ optedOut: true, until: 5_000 });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ optOuts: { U1: null, U2: 5_000 } });
  });

  it("lets a snooze run out", async () => {
    const prefs = await PreferenceStore.load(file);
    await prefs.optOut("U1", 5_000);
    expect(prefs.isOptedOut("U1", 4_999)).toBe(true);
    expect(prefs.isOptedOut("U1", 5_000)).toBe(false);
  });

  it("turns nudges back on", async () => {
    const prefs = await PreferenceStore.load(file);
    await prefs.optOut("U1", null);
    await prefs.optIn("U1");
    expect((await PreferenceStore.load(file)).isOptedOut("U1")).toBe(false);
  });

  it("refuses to start from a corrupt file rather than silently forgetting opt-outs", async () => {
    const prefs = await PreferenceStore.load(file);
    await prefs.optOut("U1", null);
    await writeFile(file, JSON.stringify({ optOuts: { U1: "forever" } }));
    await expect(PreferenceStore.load(file)).rejects.toThrow(/isn't a valid preferences file/);
  });

  it("works in memory without a file", async () => {
    const prefs = await PreferenceStore.load();
    await prefs.optOut("U1", null);
    expect(prefs.isOptedOut("U1")).toBe(true);
  });
});

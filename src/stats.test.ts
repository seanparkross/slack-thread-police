import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NudgeStats } from "./stats.js";

const NOW = Date.UTC(2026, 10, 3, 12);
const DAY = 86_400_000;

describe("NudgeStats", () => {
  describe("hourly log", () => {
    it("summarises each channel and starts afresh", async () => {
      const stats = await NudgeStats.load();
      await stats.record("C1", "nudged");
      await stats.record("C1", "nudged");
      await stats.record("C1", "moved");
      await stats.record("C2", "nudged");
      expect(stats.drain()).toEqual(["C1: 2 nudged, 1 moved, 0 ignored", "C2: 1 nudged, 0 moved, 0 ignored"]);
      expect(stats.drain()).toEqual([]);
    });

    it("suggests raising the threshold when most nudges in a channel are ignored", async () => {
      const stats = await NudgeStats.load();
      for (let i = 0; i < 6; i++) await stats.record("C1", "nudged");
      for (let i = 0; i < 4; i++) await stats.record("C1", "ignored");
      expect(stats.drain()[0]).toMatch(/consider raising REPLY_THRESHOLD/);
    });

    it("doesn't read anything into a handful of nudges", async () => {
      const stats = await NudgeStats.load();
      await stats.record("C1", "nudged");
      await stats.record("C1", "ignored");
      expect(stats.drain()[0]).not.toMatch(/consider/);
    });

    it("isn't reset by reading the summary", async () => {
      const stats = await NudgeStats.load();
      await stats.record("C1", "nudged");
      stats.summary();
      expect(stats.drain()).toEqual(["C1: 1 nudged, 0 moved, 0 ignored"]);
    });
  });

  describe("summary", () => {
    it("splits counts into the last 7 days, the last 30 and all time", async () => {
      const stats = await NudgeStats.load(undefined, NOW - 100 * DAY);
      await stats.record("C1", "nudged", NOW - 31 * DAY);
      await stats.record("C1", "nudged", NOW - 29 * DAY);
      await stats.record("C1", "nudged", NOW - 7 * DAY);
      await stats.record("C1", "nudged", NOW - 6 * DAY);
      await stats.record("C2", "ignored", NOW);
      expect(stats.summary(NOW)).toEqual({
        since: NOW - 100 * DAY,
        week: { nudged: 1, moved: 0, ignored: 1 },
        month: { nudged: 3, moved: 0, ignored: 1 },
        total: { nudged: 4, moved: 0, ignored: 1 },
        channels: [
          ["C1", { nudged: 3, moved: 0, ignored: 0 }],
          ["C2", { nudged: 0, moved: 0, ignored: 1 }],
        ],
      });
    });

    it("lists the most nudged channels first", async () => {
      const stats = await NudgeStats.load(undefined, NOW);
      await stats.record("C1", "nudged", NOW);
      await stats.record("C2", "nudged", NOW);
      await stats.record("C2", "nudged", NOW);
      expect(stats.summary(NOW).channels.map(([channel]) => channel)).toEqual(["C2", "C1"]);
    });
  });

  describe("on disk", () => {
    let dir: string;
    let file: string;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "thread-police-"));
      file = path.join(dir, "nested", "stats.json");
    });
    afterEach(() => rm(dir, { recursive: true, force: true }));

    it("keeps counts across restarts, as channel ids and numbers only", async () => {
      const stats = await NudgeStats.load(file, NOW);
      await stats.record("C1", "nudged", NOW);
      await stats.record("C1", "moved", NOW);

      const reloaded = await NudgeStats.load(file, NOW + DAY);
      expect(reloaded.summary(NOW).total).toEqual({ nudged: 1, moved: 1, ignored: 0 });
      expect(reloaded.summary(NOW).since).toBe(NOW);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        since: NOW,
        total: { nudged: 1, moved: 1, ignored: 0 },
        days: { "2026-11-03": { C1: { nudged: 1, moved: 1, ignored: 0 } } },
      });
    });

    it("drops daily counts after 30 days but keeps them in the total", async () => {
      const stats = await NudgeStats.load(file, NOW);
      await stats.record("C1", "nudged", NOW);
      await stats.record("C1", "nudged", NOW + 30 * DAY);
      const saved = JSON.parse(await readFile(file, "utf8"));
      expect(Object.keys(saved.days)).toEqual(["2026-12-03"]);
      expect(saved.total.nudged).toBe(2);
    });

    it("refuses to start from a corrupt file rather than silently resetting the counts", async () => {
      const corrupt = path.join(dir, "stats.json");
      await writeFile(corrupt, JSON.stringify({ total: "lots" }));
      await expect(NudgeStats.load(corrupt)).rejects.toThrow(/isn't a valid stats file/);
    });
  });
});

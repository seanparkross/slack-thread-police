import { describe, expect, it } from "vitest";
import { UserCooldown } from "./cooldown.js";

describe("UserCooldown", () => {
  it("holds a user for the window, then releases them", () => {
    const cooldown = new UserCooldown(60_000);
    cooldown.start("U1", 1_000);
    expect(cooldown.isCoolingDown("U1", 1_000)).toBe(true);
    expect(cooldown.isCoolingDown("U1", 60_999)).toBe(true);
    expect(cooldown.isCoolingDown("U1", 61_000)).toBe(false);
    expect(cooldown.isCoolingDown("U2", 1_000)).toBe(false);
  });

  it("can be cleared early", () => {
    const cooldown = new UserCooldown(60_000);
    cooldown.start("U1", 1_000);
    cooldown.clear("U1");
    expect(cooldown.isCoolingDown("U1", 1_000)).toBe(false);
  });

  it("is disabled with a zero window", () => {
    const cooldown = new UserCooldown(0);
    cooldown.start("U1", 1_000);
    expect(cooldown.isCoolingDown("U1", 1_000)).toBe(false);
  });
});

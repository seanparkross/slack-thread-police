import type { types } from "@slack/bolt";
import { describe, expect, it } from "vitest";
import { ADD_CHANNELS_ACTION, homeView, JOIN_ALL_ACTION, joinModal, pickedChannels } from "./home.js";
import type { Channel } from "./join.js";

const channels: Channel[] = [
  { id: "C1", name: "eng", isPrivate: false, isMember: true },
  { id: "C2", name: "design", isPrivate: false, isMember: false },
  { id: "C3", name: "support", isPrivate: false, isMember: false },
  { id: "G1", name: "secret", isPrivate: true, isMember: false },
];

const actionIds = (view: ReturnType<typeof homeView>) =>
  (view.blocks as types.KnownBlock[]).flatMap((b) =>
    b.type === "actions" ? b.elements.map((e) => ("action_id" in e ? e.action_id : "")) : [],
  );
const text = (view: ReturnType<typeof homeView>) => JSON.stringify(view.blocks);

describe("homeView", () => {
  it("gives admins the picker and a join-all button counting the public channels left", () => {
    const view = homeView({ admin: true, channels, status: "Nudges are on." });
    expect(actionIds(view)).toEqual([ADD_CHANNELS_ACTION, JOIN_ALL_ACTION]);
    expect(text(view)).toContain("Join all public channels (2 more)");
    expect(text(view)).toContain("*Watching 1 channel*\\n<#C1>");
  });

  it("drops join-all once the bot is in every public channel", () => {
    const view = homeView({ admin: true, channels: channels.slice(0, 1), status: "Nudges are on." });
    expect(actionIds(view)).toEqual([ADD_CHANNELS_ACTION]);
  });

  it("shows everyone else where it's watching, with no buttons", () => {
    const view = homeView({ admin: false, channels, status: "Nudges are off.", notice: "Done." });
    expect(actionIds(view)).toEqual([]);
    expect(text(view)).toContain("<#C1>");
    expect(text(view)).toContain("Nudges are off.");
    expect(text(view)).toContain("Done.");
  });

  it("copes with the channel list failing to load", () => {
    expect(text(homeView({ admin: true, channels: null, status: "" }))).toContain("couldn't load my channel list");
  });
});

describe("joinModal", () => {
  it("round-trips the picked channels", () => {
    const input = joinModal().blocks[0];
    expect(input?.type).toBe("input");
    const values = { channels: { picked: { selected_channels: ["C2", "C3"] } } };
    expect(pickedChannels(values)).toEqual(["C2", "C3"]);
    expect(pickedChannels({})).toEqual([]);
  });
});

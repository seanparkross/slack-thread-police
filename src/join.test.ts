import { describe, expect, it, vi } from "vitest";
import {
  type Channel,
  ChannelJoiner,
  isWorkspaceAdmin,
  type JoinClient,
  joinChannels,
  joinSummary,
  listChannels,
  resolveJoin,
} from "./join.js";

const channel = (id: string, name: string, extra: Partial<Channel> = {}): Channel => ({
  id,
  name,
  isPrivate: false,
  isMember: false,
  ...extra,
});

const eng = channel("C1", "eng");
const design = channel("C2", "design", { isMember: true });
const support = channel("C3", "support");
const secret = channel("G1", "secret", { isPrivate: true });
const ops = channel("G2", "ops", { isPrivate: true, isMember: true });
const all = [eng, design, support, secret, ops];

function fakeClient(overrides: { join?: (id: string) => void; user?: Record<string, unknown> } = {}) {
  const pages = [
    { channels: [{ id: "C1", name: "eng", is_member: false, is_private: false }], response_metadata: { next_cursor: "p2" } },
    { channels: [{ id: "G2", name: "ops", is_member: true, is_private: true }, { name: "no-id" }], response_metadata: { next_cursor: "" } },
  ];
  const list = vi.fn(async ({ cursor }: { cursor?: string }) => (cursor === "p2" ? pages[1] : pages[0]));
  const join = vi.fn(async ({ channel: id }: { channel: string }) => {
    overrides.join?.(id);
    return { ok: true };
  });
  const info = vi.fn(async () => ({ ok: true, user: overrides.user ?? {} }));
  const client = { conversations: { list, join }, users: { info } } as unknown as JoinClient;
  return { client, list, join };
}

describe("isWorkspaceAdmin", () => {
  it.each([
    [{ is_admin: true }, true],
    [{ is_owner: true }, true],
    [{ is_admin: false, is_owner: false }, false],
    [{}, false],
  ])("%j → %s", async (user, expected) => {
    await expect(isWorkspaceAdmin(fakeClient({ user }).client, "U1")).resolves.toBe(expected);
  });
});

describe("listChannels", () => {
  it("follows the cursor through every page", async () => {
    const { client, list } = fakeClient();
    await expect(listChannels(client)).resolves.toEqual([
      eng,
      channel("G2", "ops", { isPrivate: true, isMember: true }),
    ]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "p2", exclude_archived: true }));
  });
});

describe("resolveJoin", () => {
  it("joins every public channel the bot isn't in for `all`", () => {
    expect(resolveJoin({ all: true, ids: [], names: [] }, all)).toEqual({
      toJoin: [eng, support],
      already: [design, ops],
      unjoinable: [],
    });
  });

  it("finds named channels by id or name, once each", () => {
    expect(resolveJoin({ all: false, ids: ["C1", "C2"], names: ["support", "eng"] }, all)).toEqual({
      toJoin: [eng, support],
      already: [design],
      unjoinable: [],
    });
  });

  it("can't join private channels it isn't in, or channels that don't exist", () => {
    expect(resolveJoin({ all: false, ids: ["G1", "C9"], names: ["typo", "ops"] }, all)).toEqual({
      toJoin: [],
      already: [ops],
      unjoinable: ["<#G1>", "<#C9>", "#typo"],
    });
  });

  it("reports an unknown channel once, however often it's named", () => {
    expect(resolveJoin({ all: false, ids: ["C9", "C9"], names: ["typo", "typo"] }, all).unjoinable).toEqual([
      "<#C9>",
      "#typo",
    ]);
  });
});

describe("joinChannels", () => {
  it("joins each channel and keeps going past failures", async () => {
    const { client, join } = fakeClient({
      join: (id) => {
        if (id === "C3") throw new Error("An API error occurred: is_archived");
      },
    });
    const outcome = await joinChannels(client, [eng, support]);
    expect(join).toHaveBeenCalledTimes(2);
    expect(outcome.joined).toEqual([eng]);
    expect(outcome.failed.map((f) => f.channel)).toEqual([support]);
  });
});

describe("joinSummary", () => {
  it("lists a few channels by name", () => {
    const text = joinSummary(
      { toJoin: [eng], already: [design], unjoinable: ["#typo"] },
      { joined: [eng], failed: [{ channel: support, error: new Error("x") }] },
    );
    expect(text).toContain("Now watching <#C1>.");
    expect(text).toContain("Already in <#C2>.");
    expect(text).toContain("Couldn't join <#C3>.");
    expect(text).toMatch(/Couldn't find #typo.*\/invite @Thread Police/);
  });

  it("counts long lists instead", () => {
    const many = Array.from({ length: 11 }, (_, i) => channel(`C${i}`, `c${i}`));
    expect(joinSummary({ toJoin: many, already: [], unjoinable: [] }, { joined: many, failed: [] })).toBe(
      ":white_check_mark: Now watching 11 channels.",
    );
  });

  it("says when there was nothing to do", () => {
    expect(joinSummary({ toJoin: [], already: [], unjoinable: [] }, { joined: [], failed: [] })).toMatch(
      /no public channels left/,
    );
  });
});

describe("ChannelJoiner", () => {
  const ALL = { all: true, ids: [], names: [] };
  const noop = async () => {};

  it("never joins anything for someone who isn't an admin", async () => {
    const { client, join } = fakeClient({ user: { is_admin: false } });
    await expect(new ChannelJoiner(client).run("U1", ALL, noop)).resolves.toEqual({ status: "not_admin" });
    expect(join).not.toHaveBeenCalled();
  });

  it("joins for an admin and marks the cached channels as joined", async () => {
    const { client, join, list } = fakeClient({ user: { is_owner: true } });
    const joiner = new ChannelJoiner(client);
    const run = await joiner.run("U1", ALL, noop);
    expect(run.status === "done" && run.outcome.joined).toEqual([eng]);
    expect(join).toHaveBeenCalledWith({ channel: "C1" });
    expect((await joiner.channels()).find((c) => c.id === "C1")?.isMember).toBe(true);
    expect(list).toHaveBeenCalledTimes(2); // one listing of two pages, reused afterwards
  });

  it("runs one bulk join at a time", async () => {
    let release = () => {};
    const { client } = fakeClient({ user: { is_admin: true } });
    const joiner = new ChannelJoiner(client);
    const first = joiner.run("U1", ALL, noop);
    // Hold the first run inside its join loop.
    client.conversations.join = vi.fn(() => new Promise((resolve) => (release = () => resolve({ ok: true })))) as never;
    await vi.waitFor(() => expect(client.conversations.join).toHaveBeenCalled());
    await expect(joiner.run("U2", ALL, noop)).resolves.toEqual({ status: "busy" });
    release();
    await expect(first).resolves.toMatchObject({ status: "done" });
  });

  it("reuses the channel list for a minute", async () => {
    let now = 0;
    const { client, list } = fakeClient();
    const joiner = new ChannelJoiner(client, () => now);
    await joiner.channels();
    await joiner.channels();
    expect(list).toHaveBeenCalledTimes(2);
    now = 61_000;
    await joiner.channels();
    expect(list).toHaveBeenCalledTimes(4);
  });
});

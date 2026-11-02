import type { webApi } from "@slack/bolt";

export type JoinClient = Pick<webApi.WebClient, "conversations" | "users">;

export interface Channel {
  id: string;
  name: string;
  isPrivate: boolean;
  /** Whether the bot is in it, and so watching it. */
  isMember: boolean;
}

/** `/threadpolice join all`, or the channels named by id (`<#C123|eng>`) or by name (`#eng`). */
export interface JoinRequest {
  all: boolean;
  ids: string[];
  names: string[];
}

/** Bulk joining is for workspace admins and owners; anyone can still `/invite` the bot. */
export async function isWorkspaceAdmin(client: JoinClient, user: string): Promise<boolean> {
  const { user: info } = await client.users.info({ user });
  return info?.is_admin === true || info?.is_owner === true;
}

/** Every unarchived public channel, plus the private ones the bot is in (all `groups:read` shows a bot). */
export async function listChannels(client: JoinClient): Promise<Channel[]> {
  const channels: Channel[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const c of page.channels ?? []) {
      if (c.id && c.name) {
        channels.push({ id: c.id, name: c.name, isPrivate: c.is_private === true, isMember: c.is_member === true });
      }
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return channels;
}

export interface ResolvedJoin {
  toJoin: Channel[];
  already: Channel[];
  /** Mentions of what the bot can't join itself: private channels, typos, archived channels. */
  unjoinable: string[];
}

/** Sorts a request into channels to join, ones the bot is already in, and ones it can't join. */
export function resolveJoin(request: JoinRequest, channels: Channel[]): ResolvedJoin {
  const result: ResolvedJoin = { toJoin: [], already: [], unjoinable: [] };
  if (request.all) {
    for (const c of channels) {
      if (c.isMember) result.already.push(c);
      else if (!c.isPrivate) result.toJoin.push(c);
    }
    return result;
  }

  const byId = new Map(channels.map((c) => [c.id, c]));
  const byName = new Map(channels.map((c) => [c.name, c]));
  const seen = new Set<string>();
  const wanted = [
    ...request.ids.map((id) => ({ channel: byId.get(id), mention: `<#${id}>` })),
    ...request.names.map((name) => ({ channel: byName.get(name), mention: `#${name}` })),
  ];
  for (const { channel, mention } of wanted) {
    if (channel && seen.has(channel.id)) continue;
    if (channel) seen.add(channel.id);
    if (channel?.isMember) result.already.push(channel);
    else if (channel && !channel.isPrivate) result.toJoin.push(channel);
    else result.unjoinable.push(mention);
  }
  return result;
}

export interface JoinOutcome {
  joined: Channel[];
  failed: { channel: Channel; error: unknown }[];
}

/** One at a time: the client waits out Slack's rate limit (about 50 joins a minute) and retries. */
export async function joinChannels(client: JoinClient, channels: Channel[]): Promise<JoinOutcome> {
  const outcome: JoinOutcome = { joined: [], failed: [] };
  for (const channel of channels) {
    try {
      await client.conversations.join({ channel: channel.id });
      outcome.joined.push(channel);
    } catch (error) {
      outcome.failed.push({ channel, error });
    }
  }
  return outcome;
}

/** Up to this many channels are listed by name; beyond it, just counted. */
const LISTED_CHANNELS = 10;

function channelList(channels: Channel[]): string {
  if (channels.length > LISTED_CHANNELS) return `${channels.length} channels`;
  return channels.map((c) => `<#${c.id}>`).join(", ");
}

/** The mrkdwn report after a join, for the command reply and the Home tab. */
export function joinSummary(resolved: ResolvedJoin, outcome: JoinOutcome): string {
  const lines: string[] = [];
  if (outcome.joined.length > 0) lines.push(`:white_check_mark: Now watching ${channelList(outcome.joined)}.`);
  if (resolved.already.length > 0) lines.push(`Already in ${channelList(resolved.already)}.`);
  if (outcome.failed.length > 0) {
    lines.push(`:warning: Couldn't join ${channelList(outcome.failed.map((f) => f.channel))}. The bot's logs say why.`);
  }
  if (resolved.unjoinable.length > 0) {
    lines.push(
      `:warning: Couldn't find ${resolved.unjoinable.join(", ")} among the public channels. ` +
        "For a private channel, someone in it can run `/invite @Thread Police`.",
    );
  }
  return lines.length > 0 ? lines.join("\n") : "There are no public channels left for me to join.";
}

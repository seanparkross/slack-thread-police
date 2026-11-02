import type { types } from "@slack/bolt";
import type { Channel } from "./join.js";

export const ADD_CHANNELS_ACTION = "home_add_channels";
export const JOIN_ALL_ACTION = "home_join_all";
export const JOIN_MODAL = "join_channels";
const PICKER_BLOCK = "channels";
const PICKER_ACTION = "picked";

/** Section text is capped at 3,000 characters; a mention is about 15. */
const LISTED_CHANNELS = 150;

export interface HomeDetails {
  admin: boolean;
  /** Where the bot is now, or null if the list couldn't be fetched. */
  channels: Channel[] | null;
  /** The viewer's own nudge status, as a sentence. */
  status: string;
  /** The latest join report, shown at the top. */
  notice?: string | undefined;
}

const mrkdwn = (text: string): types.SectionBlock => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text: string): types.ContextBlock => ({ type: "context", elements: [{ type: "mrkdwn", text }] });

/** The bot's Home tab: where it's watching, adding channels (admins), and the viewer's own settings. */
export function homeView({ admin, channels, status, notice }: HomeDetails): types.HomeView {
  const blocks: types.KnownBlock[] = [
    { type: "header", text: { type: "plain_text", text: "Thread Police" } },
    mrkdwn("I nudge people privately when a channel message looks like it belongs in a thread. I only read channels I'm in."),
  ];
  if (notice) blocks.push(mrkdwn(notice));
  blocks.push({ type: "divider" });

  if (channels === null) {
    blocks.push(mrkdwn("*Channels*\nI couldn't load my channel list just now. Reopen this tab to try again."));
  } else {
    const watching = channels.filter((c) => c.isMember);
    const shown = watching.slice(0, LISTED_CHANNELS).map((c) => `<#${c.id}>`).join("  ");
    const more = watching.length > LISTED_CHANNELS ? ` and ${watching.length - LISTED_CHANNELS} more` : "";
    blocks.push(
      mrkdwn(
        watching.length === 0
          ? "*Channels*\nI'm not in any channels yet."
          : `*Watching ${watching.length === 1 ? "1 channel" : `${watching.length} channels`}*\n${shown}${more}`,
      ),
    );
  }

  if (admin) {
    const unjoined = channels?.filter((c) => !c.isMember && !c.isPrivate).length ?? 0;
    const buttons: types.Button[] = [
      { type: "button", action_id: ADD_CHANNELS_ACTION, style: "primary", text: { type: "plain_text", text: "Add channels…" } },
    ];
    if (unjoined > 0) {
      buttons.push({
        type: "button",
        action_id: JOIN_ALL_ACTION,
        text: { type: "plain_text", text: `Join all public channels (${unjoined} more)` },
        confirm: {
          title: { type: "plain_text", text: "Join all public channels?" },
          text: {
            type: "mrkdwn",
            text: `I'll join ${unjoined === 1 ? "1 more public channel" : `${unjoined} more public channels`} and start nudging there. You can remove me from any channel afterwards.`,
          },
          confirm: { type: "plain_text", text: "Join them" },
          deny: { type: "plain_text", text: "Cancel" },
        },
      });
    }
    blocks.push(
      { type: "actions", elements: buttons },
      context(
        "Private channels: someone in the channel runs `/invite @Thread Police`. " +
          "To stop watching a channel, remove me in its settings under *Integrations*.",
      ),
    );
  } else {
    blocks.push(
      context(
        "To add me to a channel you're in, run `/invite @Thread Police` there. Workspace admins can add me to many channels at once from this tab.",
      ),
    );
  }

  blocks.push(
    { type: "divider" },
    mrkdwn(`*Your nudges*\n${status}`),
    context("`/threadpolice off` stops them, `/threadpolice snooze 2h` pauses them, and `/threadpolice on` turns them back on."),
  );
  return { type: "home", blocks };
}

/** Opened by "Add channels…": Slack's own picker, so even big workspaces are a few keystrokes. */
export function joinModal(): types.ModalView {
  return {
    type: "modal",
    callback_id: JOIN_MODAL,
    title: { type: "plain_text", text: "Add channels" },
    submit: { type: "plain_text", text: "Add" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: PICKER_BLOCK,
        label: { type: "plain_text", text: "Public channels to watch" },
        element: {
          type: "multi_channels_select",
          action_id: PICKER_ACTION,
          placeholder: { type: "plain_text", text: "Type to search channels" },
        },
      },
      context("Private channels aren't listed. Someone in the channel can run `/invite @Thread Police` instead."),
    ],
  };
}

type ViewState = Record<string, Record<string, { selected_channels?: string[] }>>;

/** The channel ids picked in the join modal. */
export function pickedChannels(values: ViewState): string[] {
  return values[PICKER_BLOCK]?.[PICKER_ACTION]?.selected_channels ?? [];
}

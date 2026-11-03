# How it works

1. The bot listens to messages in the channels it's in, keeping an in-memory window (`CONTEXT_MESSAGES`, `CONTEXT_MAX_AGE_MINUTES`) up to date with new posts, edits, deletes and thread replies. The first time it sees a channel, it seeds the window from recent history.
2. For each new top-level message from a person, it asks the model two typed questions through TypeSafe's System One API (`POST /v1/systemone`):
   - `is_reply` (yes/no): is this a response to one specific earlier message?
   - `parent` (choice): which recent message, or `none`?
3. If both probabilities clear their thresholds (`REPLY_THRESHOLD`, `PARENT_THRESHOLD`), the nudge goes out straight away, privately, quoting the start of the earlier message. A cooldown (`USER_COOLDOWN_MINUTES`) then stops that person being nudged again for a while.
4. Further follow-ups to the same message don't get nudges of their own. They join the first one, so **Move to thread** moves them all, and the confirmation gives the real count.

Slack doesn't let a bot edit a private nudge once it's sent, so the nudge can't count follow-ups that arrive after it; it says up front that Move takes them too. If you'd rather have one nudge that counts the whole run ("Your last 3 messages…"), set `NUDGE_DELAY_SECONDS` to wait for the person to stop typing first (at most a minute in all).

When the earlier message is the author's own, the nudge calls it a follow-up to "your earlier message" instead.

It skips bot posts, thread replies, messages with files, and `@channel` / `@here` / `@everyone` announcements.

If the model is unreachable or errors, the bot logs it and stays silent.

Every check is logged with its probabilities (ids only), and once an hour the bot logs how many nudges each channel got and how many were moved or ignored, flagging channels where most nudges are ignored.

## Stats

`/threadpolice stats` shows anyone, privately, how the bot is doing across the workspace: how many nudges went out in the last 7 days, the last 30 days and all time, and how many of those were moved to a thread, ignored or left unanswered. Below that it lists the ten most nudged channels over the last 30 days, flagging any where most nudges are ignored (a sign `REPLY_THRESHOLD` is too low there). As on the Home tab, only workspace admins and owners see private channels in that list; everyone else sees public channels only. The totals above it cover every channel.

The counts are kept in `DATA_DIR/stats.json` as channel ids and numbers, never who was nudged or what they wrote. Daily counts older than 30 days are dropped; the all-time totals keep them. Counting starts the first time a version with stats runs. If the file can't be read, the bot renames it to `stats.json.corrupt`, logs a warning and starts counting afresh rather than refusing to start.

## Turning nudges off

Anyone can control their own nudges with a slash command. The reply is private.

| Command | Effect |
| --- | --- |
| `/threadpolice off` | Stop nudging me. |
| `/threadpolice snooze 2h` | Pause for a while: minutes, hours, days or weeks (`30m`, `2h`, `3d`, `1w`), up to 90 days. |
| `/threadpolice on` | Turn nudges back on. |
| `/threadpolice status` | Show whether nudges are on, off or snoozed. |
| `/threadpolice stats` | Show how many nudges went out and what people did with them ([Stats](#stats)). |

## Choosing channels

The bot only reads channels it's in. Anyone can add it to a channel they're in with `/invite @Thread Police`, and remove it in the channel's settings under **Integrations**.

Workspace admins and owners can add it to public channels in bulk:

| Where | How |
| --- | --- |
| The bot's **Home** tab | **Add channels…** opens Slack's channel picker; **Join all public channels** joins every one it isn't in yet. The tab also lists the public channels the bot is watching, for everyone; admins also see how many private channels it's in. |
| `/threadpolice join #eng #design` | Joins the named public channels. |
| `/threadpolice join all` | Joins every public channel. |

Each join shows Slack's usual short "joined" notice in that channel, so **Join all** announces the bot everywhere at once. Private channels can't be joined this way: Slack only lets someone inside invite a bot. Only one bulk join runs at a time. Slack allows about 50 joins a minute, so joining hundreds of channels takes a few minutes; the bot reports back when it's done. It doesn't join channels created later on its own.

## About "Move to thread"

A bot token can't post as a user or delete their messages, so Move is a copy: the bot posts the message into the thread with the author's name and avatar (Slack labels it as an app message, with a small "Moved from the channel by Thread Police" line), and the nudge changes to "Moved — you can now delete your original" with a link to the copy.

**Optional: delete the original too.** Set `SLACK_USER_TOKEN` to the User OAuth Token (`xoxp-…`) of a workspace admin or owner (see [setup step 1.6](setup.md#1-create-the-slack-app)). Move then deletes the original after posting the copy, and the nudge just says "Moved to the thread". This only works for messages that admin is allowed to delete: their own always, other people's only if your workspace lets admins delete members' messages. Slack records those deletes as done by that admin. If a delete fails, Move falls back to asking the author to delete it.

Move leaves a message where it is if it already has thread replies of its own (moving it would strand them), and refuses if the earlier message has been deleted. A true one-click move, where the copy is posted as the person themselves, is in the [backlog](../BACKLOG.md).

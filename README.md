# Slack Thread Police

A free, open-source, self-hosted Slack bot that keeps channels tidy. When someone posts a top-level message that belongs in the thread of a recent message (most often a follow-up to their own earlier message, or a reply to someone else's), Thread Police sends them a private nudge ("Only visible to you"):

> 🧵 This looks like a follow-up to your earlier message:
> > Does anyone know when the staging deploy is scheduled for today?
>
> Move it, and any follow-ups, into the thread?
>
> **[Move to thread]** [Ignore]

**Move to thread** reposts the messages into the right thread under the author's name and avatar, then tells them they can delete the originals (or deletes them itself, if you allow it). **Ignore** dismisses the nudge. Nobody else sees anything, and anyone can turn nudges off for themselves with `/threadpolice off`.

Each workspace runs its own copy: you create a Slack app from the included manifest and run the bot in Docker using Socket Mode, so it needs no public URL.

## Privacy

- **Message content is never persisted.** The bot keeps a small rolling window of recent top-level messages per channel in memory, and only for channels it has been invited to. A restart forgets everything.
- The only file it writes is `DATA_DIR/preferences.json`: the user ids of people who turned nudges off or snoozed them, and until when.
- To decide whether a message is a reply, the bot sends the new message and the recent window to the decision model ([TypeSafe](https://typesafe.ai)'s hosted Jev by default, or a model you host yourself; see below). Nothing else leaves your infrastructure.
- Logs never include message text at the default `LOG_LEVEL=info`; they show message ids, probabilities and counts. At `LOG_LEVEL=debug`, Slack's Bolt SDK logs raw event payloads, which do include message text.
- Nudge buttons carry only message ids, never content.

## How it works

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

### Turning nudges off

Anyone can control their own nudges with a slash command. The reply is private.

| Command | Effect |
| --- | --- |
| `/threadpolice off` | Stop nudging me. |
| `/threadpolice snooze 2h` | Pause for a while: minutes, hours, days or weeks (`30m`, `2h`, `3d`, `1w`), up to 90 days. |
| `/threadpolice on` | Turn nudges back on. |
| `/threadpolice status` | Show whether nudges are on, off or snoozed. |

### About "Move to thread"

A bot token can't post as a user or delete their messages, so Move is a copy: the bot posts the message into the thread with the author's name and avatar (Slack labels it as an app message, with a small "Moved from the channel by Thread Police" line), and the nudge changes to "Moved — you can now delete your original" with a link to the copy.

**Optional: delete the original too.** Set `SLACK_USER_TOKEN` to the User OAuth Token (`xoxp-…`) of a workspace admin or owner (see setup step 6). Move then deletes the original after posting the copy, and the nudge just says "Moved to the thread". This only works for messages that admin is allowed to delete: their own always, other people's only if your workspace lets admins delete members' messages. Slack records those deletes as done by that admin. If a delete fails, Move falls back to asking the author to delete it.

Move leaves a message where it is if it already has thread replies of its own (moving it would strand them), and refuses if the earlier message has been deleted. A true one-click move, where the copy is posted as the person themselves, is in the [backlog](BACKLOG.md).

## Setup

**Have an AI agent do it.** If you use an agent that can drive your browser and a shell (for example Claude Code with Claude in Chrome), paste the prompt from [`AGENT_SETUP.md`](AGENT_SETUP.md) into it. It asks you a few questions, creates the Slack app, collects the keys from your browser into a locked-down env file, starts the bot locally or on your server, and tests it. The manual steps are below.

### 1. Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**, pick your workspace, and paste the contents of [`slack-app-manifest.yml`](slack-app-manifest.yml).
2. **Install to Workspace**. Copy the **Bot User OAuth Token** (`xoxb-…`) from **OAuth & Permissions** into `SLACK_BOT_TOKEN`.
3. Under **Basic Information → App-Level Tokens**, generate a token with the `connections:write` scope. Copy it (`xapp-…`) into `SLACK_APP_TOKEN`.
4. The manifest fills in the app's name, short and long description and background colour (**Basic Information → Display Information**). Upload [`assets/icon.png`](assets/icon.png) there as the app icon yourself, since manifests can't set one.
5. Invite the bot to each channel it should watch: `/invite @Thread Police`. It only ever sees channels it's a member of, so removing it from a channel turns it off there.
6. *Optional, so Move deletes originals:* the manifest also requests the `chat:write` user scope, so installing creates a **User OAuth Token** (`xoxp-…`) for whoever installed the app, shown on **OAuth & Permissions**. If that person is a workspace admin or owner, put it in `SLACK_USER_TOKEN`. Treat it like a password: it can post and delete as that admin.

*Updating an existing app:* when a new version changes `slack-app-manifest.yml` (for example to add `/threadpolice`), paste it into your app's **App Manifest** page, save, and reinstall from **OAuth & Permissions**. Your tokens stay the same.

### 2. Get a TypeSafe API key

Create a key in the [TypeSafe console](https://console.typesafe.ai/keys) and put it in `TYPESAFE_API_KEY`. You pay TypeSafe directly for your own usage; this project doesn't proxy anything.

### 3. Configure

```bash
cp .env.example .env
```

Then fill in the three required values.

### 4. Run

With Docker:

```bash
docker compose up -d --build
```

Or with Node 22+ and pnpm:

```bash
pnpm install
pnpm dev
```

`pnpm dev:watch` restarts on file changes. For production without Docker, run `pnpm build`, then `pnpm start` (which doesn't load `.env` itself, so export the variables or use `node --env-file=.env dist/index.js`).

## Running it on your own server

Any small Linux VPS will do (Hetzner, DigitalOcean, Linode, a Raspberry Pi at home). The bot is light: about 60 MB of memory and next to no CPU, so the smallest plan is plenty.

**No inbound ports are needed.** Socket Mode means the bot opens an outbound connection to Slack, so there's no public URL, TLS certificate or open firewall port to set up. Keep the firewall closed to everything but SSH.

**Run exactly one copy per Slack app.** If your laptop and the server both run with the same tokens, Slack splits events between them and each one only sees half the conversation. Stop any local copy (`docker compose down`, or quit `pnpm dev`) when the server one starts.

### Your keys

The bot reads its keys from environment variables, and both methods below load them from a file you create **on the server only**:

| Variable | Where it comes from | What it can do |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` (`xoxb-…`) | Your app's **OAuth & Permissions** page (step 1.2) | Read the channels the bot is in, post as the bot |
| `SLACK_APP_TOKEN` (`xapp-…`) | **Basic Information → App-Level Tokens** (step 1.3) | Open the Socket Mode connection |
| `TYPESAFE_API_KEY` | The [TypeSafe console](https://console.typesafe.ai/keys) (step 2) | Spend on your TypeSafe account |
| `SLACK_USER_TOKEN` (`xoxp-…`), optional | **OAuth & Permissions**, User OAuth Token (step 1.6) | Post and **delete any message** as the admin who installed the app |

To keep them safe:

- Create the file with only your user able to read it, *then* open it in an editor and paste the values in. Don't `echo` tokens into the file: that leaves them in your shell history.
- Never commit the file (`.env` is already in `.gitignore`), and don't put the server on a box where untrusted code or other people run as the same user.
- Leave `SLACK_USER_TOKEN` out unless you want Move to delete the originals. Without it, Move still copies messages into the thread.
- If a key leaks, or when you rotate it: regenerate it in Slack (**OAuth & Permissions → Revoke / reinstall**, or a new app-level token) or the TypeSafe console, put the new value in the file and restart the bot.

### Option A: Docker

Install Docker Engine and the Compose plugin ([docs.docker.com/engine/install](https://docs.docker.com/engine/install/)), then:

```bash
git clone https://github.com/seanparkross/slack-thread-police.git slack-thread-police
cd slack-thread-police
install -m 600 .env.example .env   # readable by you only
nano .env                          # fill in the keys
docker compose up -d --build
docker compose logs -f             # wait for "Slack Thread Police is running"
```

`restart: unless-stopped` brings it back after a crash or reboot, and opt-outs live in the `thread-police-data` volume.

To update: `git pull && docker compose up -d --build`. After editing `.env`, run `docker compose up -d --force-recreate` so the container picks up the new values.

### Option B: Node and systemd, no Docker

If the server already has Node 22+ and you'd rather not install Docker, [`deploy/slack-thread-police.service`](deploy/slack-thread-police.service) runs the bot as a locked-down systemd service. It uses a throwaway system user, keeps the keys in a root-only file, and stores opt-outs in `/var/lib/slack-thread-police`. As root:

```bash
git clone https://github.com/seanparkross/slack-thread-police.git /opt/slack-thread-police
cd /opt/slack-thread-police
npx pnpm@12 install --frozen-lockfile
npx pnpm@12 build
npx pnpm@12 prune --prod

install -d -m 700 /etc/slack-thread-police
install -m 600 .env.example /etc/slack-thread-police/env
nano /etc/slack-thread-police/env  # fill in the keys

cp deploy/slack-thread-police.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now slack-thread-police
journalctl -u slack-thread-police -f  # wait for "Slack Thread Police is running"
```

To update: `git pull`, then the three `pnpm` lines again, then `systemctl restart slack-thread-police`. After editing the keys, just restart.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | *required* | Bot User OAuth Token (`xoxb-…`). |
| `SLACK_APP_TOKEN` | *required* | App-level token with `connections:write` (`xapp-…`), for Socket Mode. |
| `SLACK_USER_TOKEN` | *unset* | A workspace admin's User OAuth Token (`xoxp-…`). When set, Move deletes the original. |
| `TYPESAFE_API_KEY` | *required* | Your TypeSafe API key. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | Any server that speaks `/v1/systemone`. |
| `TYPESAFE_MODEL` | `jev-latest` | Model name sent with each request. |
| `TYPESAFE_TIMEOUT_MS` | `10000` | Per-attempt timeout. Failed calls are retried once. |
| `TYPESAFE_COMPRESSION` | `auto` | Request compression: `auto` (zstd where Node supports it), `zstd` or `off`. |
| `REPLY_THRESHOLD` | `0.75` | Minimum probability that the message is a reply at all. |
| `PARENT_THRESHOLD` | `0.6` | Minimum probability on the specific parent message. |
| `CONTEXT_MESSAGES` | `20` | How many recent top-level messages to consider (1–100). |
| `CONTEXT_MAX_AGE_MINUTES` | `120` | Ignore messages older than this. |
| `USER_COOLDOWN_MINUTES` | `10` | At most one nudge per person in this window. `0` disables it. |
| `NUDGE_DELAY_SECONDS` | `0` | Nudge right away (`0`), or wait this long after someone's last follow-up so a burst gets one nudge that counts it (0–120). |
| `DATA_DIR` | `data` | Where `/threadpolice` opt-outs and snoozes are saved. Docker Compose keeps it in a named volume. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

Raise the thresholds if nudges feel too eager; lower them if obvious replies slip through.

## Self-hosting the model

llama.cpp's `llama-server` serves the same `/v1/systemone` API for open decision models, so switching away from the hosted Jev is a config change:

```bash
TYPESAFE_BASE_URL=http://localhost:8080
TYPESAFE_MODEL=<the model name your server expects>
# Local models on CPU can be slow:
TYPESAFE_TIMEOUT_MS=30000
# Only if your server rejects zstd-compressed request bodies:
TYPESAFE_COMPRESSION=off
```

`TYPESAFE_API_KEY` is still required by the SDK; set it to whatever your server expects, or any placeholder if it doesn't check. Inside Docker Compose, use the server's service name or `host.docker.internal` rather than `localhost`.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```

See [CLAUDE.md](CLAUDE.md) for the code layout.

## Roadmap

Planned and possible work lives in [BACKLOG.md](BACKLOG.md).

## License

[MIT](LICENSE) © Parklife, Inc.

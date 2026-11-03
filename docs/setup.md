# Manual setup

These are the steps the [agent prompt](../AGENT_SETUP.md) follows, if you'd rather do them yourself.

## 1. Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**, pick your workspace, and paste the contents of [`slack-app-manifest.yml`](../slack-app-manifest.yml).
2. **Install to Workspace**. Copy the **Bot User OAuth Token** (`xoxb-…`) from **OAuth & Permissions** into `SLACK_BOT_TOKEN`.
3. Under **Basic Information → App-Level Tokens**, generate a token with the `connections:write` scope. Copy it (`xapp-…`) into `SLACK_APP_TOKEN`.
4. The manifest fills in the app's name, short and long description and background colour (**Basic Information → Display Information**). Upload [`assets/icon.png`](../assets/icon.png) there as the app icon yourself, since manifests can't set one.
5. Add the bot to the channels it should watch. It only ever sees channels it's a member of, so removing it from a channel turns it off there. A workspace admin or owner can add it to public channels in bulk:
   - open **Thread Police** in Slack's sidebar (under **Apps**) and, on its **Home** tab, click **Add channels…** to pick several at once, or **Join all public channels**; or
   - run `/threadpolice join #eng #design #support`, or `/threadpolice join all`.

   Private channels need someone in them to run `/invite @Thread Police`; anyone can also add it to a single channel that way.
6. *Optional, so Move deletes originals:* the manifest also requests the `chat:write` user scope, so installing creates a **User OAuth Token** (`xoxp-…`) for whoever installed the app, shown on **OAuth & Permissions**. If that person is a workspace admin or owner, put it in `SLACK_USER_TOKEN`. Treat it like a password: it can post and delete as that admin.

*Updating an existing app:* when a new version changes `slack-app-manifest.yml` (for example, adding the Home tab and the `channels:read`, `groups:read` and `channels:join` scopes for joining channels in bulk), paste it into your app's **App Manifest** page, save, and reinstall from **OAuth & Permissions**. Your tokens stay the same. New `/threadpolice` subcommands (like `stats`) work without this; updating the manifest only refreshes the hint Slack shows as you type.

## 2. Get a TypeSafe API key

Create a key in the [TypeSafe console](https://console.typesafe.ai/keys) and put it in `TYPESAFE_API_KEY`. You pay TypeSafe directly for your own usage; this project doesn't proxy anything.

## 3. Configure

```bash
cp .env.example .env
```

Then fill in the three required values. Every other setting is optional; see [Configuration](configuration.md).

## 4. Run

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

If the server already has Node 22+ and you'd rather not install Docker, [`deploy/slack-thread-police.service`](../deploy/slack-thread-police.service) runs the bot as a locked-down systemd service. It uses a throwaway system user, keeps the keys in a root-only file, and stores opt-outs in `/var/lib/slack-thread-police`. As root:

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

# Set up Thread Police with your AI agent

Your AI agent can do the whole setup for you: create the Slack app, collect the keys from your browser, start the bot on your computer or server, and test it. You answer a few questions and approve a few clicks.

**You need:**

- An agent that can control your web browser and run shell commands. For example, [Claude Code](https://claude.com/claude-code) with [Claude in Chrome](https://claude.com/chrome).
- That browser signed in to your Slack workspace, and to the [TypeSafe console](https://console.typesafe.ai). Create a TypeSafe account first if you don't have one. Agents shouldn't sign up for accounts on your behalf.
- To run it on a server: SSH access from the agent's machine (`ssh you@your-server` works without a password prompt).

**Then** paste everything in the box below into your agent.

---

````text
Set up Slack Thread Police for me, end to end. It's an open-source, self-hosted Slack bot:
https://github.com/seanparkross/slack-thread-police

Do as much of this yourself as you can, using my browser (where I'm signed in to Slack and the
TypeSafe console) and the shell. Only hand a step back to me when you can't do it, and then
tell me exactly what to click and paste.

## 0. Before you start

Clone the repository and read README.md, docs/setup.md, docs/configuration.md,
slack-app-manifest.yml and .env.example, so you know how the bot works and which settings exist:

    git clone https://github.com/seanparkross/slack-thread-police.git

Then ask me all of these questions in ONE message, with your suggested default for each, and
wait for my answers:

1. Which Slack workspace? (Its URL, such as acme.slack.com.) Am I an owner or admin there, or
   allowed to install apps? Some workspaces need an admin to approve new apps.
2. Is there already a Thread Police app in that workspace? (If so, update it rather than create
   a second one. Two apps would mean two bots nudging people.)
3. Which channels should it watch? Suggest starting with one or two. It only sees channels it's
   in. Admins can add it to many public channels at once, or all of them; private channels need
   an invite from inside.
4. Should "Move to thread" also delete the original messages? This needs an extra admin token
   and only works if I'm a workspace owner or admin. Without it, Move copies the message into
   the thread and tells the author to delete the original.
5. Where should it run?
   a. This computer, with Docker. Good for trying it out, but it stops when the computer sleeps.
   b. A Linux server I can SSH into, with Docker. Ask for user@host, and whether Docker is
      installed or you may install it.
   c. A Linux server without Docker, as a systemd service using Node 22+. Needs root or sudo.
      Best when other people or other agents share the server, because the keys stay
      root-only.
6. May you create a private test channel (#thread-police-test, just me and the bot) and post a
   few test messages in it? If not, which channel may you test in?

## 1. Rules for the keys

The setup produces three or four secrets: SLACK_BOT_TOKEN (xoxb-…), SLACK_APP_TOKEN (xapp-…),
TYPESAFE_API_KEY and, optionally, SLACK_USER_TOKEN (xoxp-…, which can delete any message in the
workspace as me).

- Never show a key's value in chat, in summaries, in commit messages or in issues. Refer to
  keys by name only. When you check a file, print only the variable names, never the values.
- Store keys only in the bot's env file, created with mode 600 before anything is written to
  it: `.env` in the repo for options a and b, or `/etc/slack-thread-police/env` (owned by root)
  for option c. Never commit them. `.env` is already gitignored.
- To get keys onto a server, pipe them over SSH stdin, such as
  `ssh host 'umask 077; cat > path' < local-file`. Don't put them on a remote command line,
  where `ps` and shell history can see them. Delete any local temporary file straight after.
- Only add SLACK_USER_TOKEN if I said yes to question 4 and you've confirmed I'm an owner or
  admin (see step 4 below).

## 2. Create the Slack app (in my browser)

1. Open https://api.slack.com/apps. If a Thread Police app already exists for this workspace,
   open it, go to App Manifest, replace the manifest with the contents of
   slack-app-manifest.yml, save, and go on to step 3. Otherwise click Create New App → From a
   manifest, pick the workspace, choose YAML, paste slack-app-manifest.yml exactly as it is,
   then Next → Create.
2. Basic Information → Display Information: upload assets/icon.png as the app icon. The
   manifest already sets the name, descriptions and colour. If your browser tools can't upload
   files, ask me to drag the file in and wait.
3. Basic Information → App-Level Tokens → Generate Token and Scopes. Name it "socket", add the
   connections:write scope and generate it. This is SLACK_APP_TOKEN (xapp-…).
4. Install the app: Install App (or OAuth & Permissions) → Install to <workspace>. Slack shows
   a permissions screen. Tell me what it asks for and get my OK before clicking Allow. If the
   workspace needs admin approval instead, stop and tell me who has to approve it.
5. OAuth & Permissions → OAuth Tokens: the Bot User OAuth Token (xoxb-…) is SLACK_BOT_TOKEN, and
   the User OAuth Token (xoxp-…) is SLACK_USER_TOKEN, if I want deletion.

Read each token from the page straight into the env file (see the rules above).

## 3. Get a TypeSafe API key (in my browser)

Open https://console.typesafe.ai/keys and create a key named "thread-police". It may only be
shown once, so copy it straight into the env file as TYPESAFE_API_KEY. If there's no account or
billing set up, stop and ask me to do that part. The bot's model calls are billed to my
TypeSafe account.

## 4. Check the keys before starting anything

Load the env file into your shell without printing it, then check each key with Slack's API.
Print only the fields named here:

- SLACK_BOT_TOKEN: GET https://slack.com/api/auth.test with "Authorization: Bearer <token>".
  Expect ok:true, the right team name and a user of thread_police. The response's
  x-oauth-scopes header should include channels:history, groups:history, chat:write,
  chat:write.customize, users:read, commands, channels:read, groups:read and channels:join.
- SLACK_APP_TOKEN: POST https://slack.com/api/apps.connections.open with the same header.
  Expect ok:true.
- SLACK_USER_TOKEN, if used: auth.test gives the user_id. Then call
  users.info?user=<user_id> with the BOT token. Keep the user token only if is_admin or
  is_owner is true. Otherwise remove it and tell me why.
- TYPESAFE_API_KEY can't be checked separately. The first nudge proves it works.

If any check fails, fix it before going further.

## 5. Start the bot

Exactly one copy may run per Slack app. If Slack splits events between two copies, each one
only sees half of each conversation. Stop any copy that's already running before you start a
new one.

Follow docs/setup.md, section "Running it on your own server", for the option I picked:

- a. On this computer: `cp .env.example .env` (mode 600), fill it in, then
  `docker compose up -d --build`.
- b. Server with Docker: clone the repo on the server, create `.env` there (mode 600) using
  ssh stdin, then `docker compose up -d --build`. Ask before installing Docker.
- c. Server without Docker: follow "Option B: Node and systemd" in docs/setup.md as root, with the
  keys in /etc/slack-thread-police/env (root, mode 600) and the unit file from deploy/. Check
  `node --version` is 22 or newer first, and ask before installing anything.

Don't change anything else on a server: other services, firewall rules, users and packages
stay as they are unless I say otherwise. No inbound ports are needed, because Socket Mode only
connects outward.

Watch the logs (`docker compose logs -f`, or `journalctl -u slack-thread-police -f`) until you
see "Slack Thread Police is running (Socket Mode)". The line ends with "Move deletes originals"
when the admin token is in use, and "Move keeps originals" when it isn't.

## 6. Invite the bot and test it (in my browser)

1. Add the bot to the channels from question 3. For public channels, if I'm an admin or owner,
   send `/threadpolice join #channel-one #channel-two` (or `/threadpolice join all` if I asked
   for every public channel) in any channel and check its reply. For private channels, and
   if I'm not an admin, send `/invite @Thread Police` in each one. For the test channel, create
   it first if I agreed to that.
2. In the test channel, post a question ("What time does the office close on Friday?"), wait
   a few seconds, then post a follow-up as a separate top-level message ("Asking because I need
   to pick up a parcel"). A private "Only visible to you" nudge should appear within a few
   seconds, quoting the question, with Move to thread and Ignore buttons.
3. Click Move to thread. The follow-up should appear in the question's thread, and the original
   should disappear if deletion is on. Then send `/threadpolice status` and check the reply
   says nudges are on.
4. If no nudge appears, read the bot's logs. Each message gets a "Checked … reply 0.xx, parent
   … → …" line saying why it did or didn't nudge. Fix what you can, and tell me what you
   can't. Never raise LOG_LEVEL to debug without asking me, because debug logs include message
   text.

## 7. Report back

Tell me, briefly:
- where it runs, how to see its logs, and how to stop, restart and update it;
- which channels it's in, and that anyone can run `/threadpolice off` or
  `/threadpolice snooze 1d`;
- whether Move deletes originals;
- anything you skipped or couldn't do;
- that if a key value was ever shown in this chat, I should regenerate it: in Slack (OAuth &
  Permissions, or App-Level Tokens) or in the TypeSafe console, then update the env file and
  restart the bot.
````

---

**What the agent will ask you to do yourself:** approve the Slack permissions screen, and sometimes drag the icon file in. If your workspace needs admin approval for new apps, the agent can't approve it for you; whoever approves apps in your workspace has to.

**More than one workspace?** Each workspace needs its own app and its own running copy. Run the prompt once per workspace, and on a server give each copy its own folder (Docker) or its own service name and env file (systemd).

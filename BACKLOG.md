# Backlog

Work we've discussed but not started, roughly in priority order. Each item should make sense on its own, so it can be picked up without the conversation that produced it. When something ships, delete it from here (git history keeps the record).

## Evaluation set for tuning detection

**Why.** The thresholds (`REPLY_THRESHOLD` 0.75, `PARENT_THRESHOLD` 0.6) and the questions we ask the model are educated guesses. Changing them today means trying a few messages in Slack and hoping.

**What it is.** A file of made-up but realistic channel snippets, each with the right answer written down by a person: "the last message is a follow-up to message 2" or "the last message is a new topic". A script runs the detector over every snippet and reports two numbers:

- how many of the nudges it would send are right (too many wrong ones annoys people);
- how many real follow-ups it would catch (too few and the bot is useless).

Then any change to the prompt, thresholds or model can be judged on the same test, before anyone in Slack sees it.

**Done when.** `pnpm eval` runs about 50 labelled snippets through the detector (real model calls, opt-in because they cost money) and prints both numbers, plus the snippets it got wrong.

## Channel controls

**Why.** The bot only watches channels it has been invited to, so adding or removing it is already an on/off switch per channel. What's missing is "watch this channel, but be stricter here" (a busy #general) and a way for admins to see where it's active.

**Options.** Environment variables are simplest for self-hosters (`CHANNEL_THRESHOLDS=C123:0.9`). An admin-only slash command (`/threadpolice channel strict`, checking the caller is a workspace admin) is friendlier but needs storing per-channel settings next to `preferences.json`.

**Done when.** Admins can set a stricter threshold for a channel without redeploying, and `/threadpolice status` in a channel shows its setting.

## Follow-ups with files or screenshots

**Why.** "Here's a screenshot" is a classic follow-up, but messages with files are skipped today.

**Two parts.**

1. *Detection.* Messages with a caption can be judged on the text alone. Screenshot-only messages would need the model to see the image: the TypeSafe SDK supports image inputs, but they're experimental and opt-in (`TypeSafe-Danger-Zone-Images` header). Start with captioned messages only.
2. *Moving.* A bot can't attach someone else's file to a new message, so Move would download the file (`files:read`) and re-upload it into the thread (`files:write`). With the admin token, the original can then be deleted as usual.

**Done when.** A captioned screenshot posted as a follow-up gets nudged, and Move puts the image and caption in the thread.

## Continuous integration and a published image

**Why.** Catch broken changes automatically, and let self-hosters run the bot without cloning the repo.

**Done when.** Every push runs typecheck, tests and build on GitHub Actions, and tagged releases publish an image to GitHub's container registry, so the setup docs can say `docker run --env-file .env ghcr.io/…/slack-thread-police`.

## Health check and structured logs

**Why.** If the bot loses its Slack connection, nothing notices. Plain-text logs are also hard to search once it runs somewhere real.

**Done when.** The container has a health check that fails when the Socket Mode connection is down (so Docker restarts it), and `LOG_FORMAT=json` switches logs to one JSON object per line.

## True one-click move (per-person sign-in)

**Why.** Today Move posts a copy with an APP badge and a "Moved from the channel" footer, and only deletes the original if an admin token is configured.

**What it is.** Each person signs in to Thread Police once ("Sign in with Slack"). With their own token, Move posts as them (no badge, no footer) and deletes their own original. It needs a small web page for Slack's sign-in redirect (reachable by people's browsers only, so a Tailscale address works) and somewhere to keep each person's token, encrypted.

**Done when.** A signed-in person's Move leaves no trace of the bot in the thread, and people who haven't signed in still get today's copy.

## Recipes for self-hosted decision models

**Why.** `TYPESAFE_BASE_URL` can point at llama.cpp's `llama-server`, but nobody has tried it yet.

**Done when.** `docs/configuration.md` has a tested recipe (model, `llama-server` flags, expected speed on a small machine) that passes the evaluation set above reasonably well.

## Hosted, multi-workspace version

**Why.** Installing from the Slack Marketplace would reach people who won't self-host.

**What changes.** Slack requires HTTP mode (a public URL) instead of Socket Mode for distributed apps, plus OAuth installs with per-workspace tokens stored securely, and a privacy policy for processing other companies' messages. Large; only worth it if the self-hosted version proves useful.

# CLAUDE.md

Slack Thread Police: a self-hosted Slack bot (Bolt, Socket Mode) that privately nudges people to move channel replies into threads. Detection uses TypeSafe's System One API (`@typesafe-ai/sdk`) with typed `noul` / `choice` questions.

## Commands

- `pnpm dev` — run once with `.env` loaded (exits on config errors); `pnpm dev:watch` restarts on change
- `pnpm typecheck` / `pnpm test` / `pnpm build` — all three must pass before handing work back
- `docker compose up -d --build` — production-style run (stop any local `pnpm dev` first, or both copies answer Slack)
- `deploy/slack-thread-police.service` — systemd unit for running on a server without Docker; "Running it on your own server" in `docs/setup.md` covers both ways

## Architecture (`src/`)

- `index.ts` — entry: load config, build the Bolt `App`, register handlers, graceful shutdown
- `config.ts` — zod parsing of env vars into a typed `Config`; empty values count as unset
- `app.ts` — Bolt handlers: buffer sync (replies, edits, deletes), the nudge flow, the `move_to_thread` / `ignore_suggestion` actions, the `/threadpolice` command and the Home tab
- `eligibility.ts` — pure rules: which messages can be nudged, which can be parents, thread parent lookup
- `buffer.ts` — `ChannelBuffer`, the in-memory rolling window per channel
- `detector.ts` — `buildRequest()` (the System One prompt) and `ThreadDetector` (threshold logic)
- `decision.ts` — `TypeSafeClient` construction
- `burst.ts` — `BurstTracker`: groups a person's follow-ups to one message under one nudge (sent at once, or after `NUDGE_DELAY_SECONDS` of quiet) and keeps collecting them for Move
- `cooldown.ts` — per-user nudge cooldown
- `commands.ts` — `/threadpolice off | on | snooze <duration> | status`, and parsing `join #channel… | join all`
- `join.ts` — admin check, channel listing and bulk `conversations.join` for the Home tab and `/threadpolice join` (admins and owners only; public channels only)
- `home.ts` — Block Kit for the Home tab (where the bot is watching, Add channels / Join all) and the channel-picker modal
- `preferences.ts` — `PreferenceStore`, the opt-outs saved to `DATA_DIR/preferences.json`
- `stats.ts` — per-channel nudge/move/ignore counts, logged hourly
- `blocks.ts` — Block Kit for the nudge and its replacements; button values carry ids only
- `move.ts` — copy-based move (repost into the thread as the author via `chat:write.customize`), then delete the original when an admin `SLACK_USER_TOKEN` is configured

## Conventions

- The optional admin user token is used only for `chat.delete` in `move.ts`; don't widen its use.
- **Never persist or log message content.** State lives in memory, except `preferences.json`, which holds user ids and times only. Log ids, reasons and probabilities, not text. Errors go through `describeError`.
- Keep Slack API calls in `app.ts` / `move.ts` / `join.ts`; keep everything else pure and unit-tested with fakes (see `*.test.ts` next to each module).
- Model calls failing must never surface to users: log and stay silent.
- Choice options are listed newest first because Jev leans toward the first option; keep that when changing the prompt.
- The base URL stays configurable so any `/v1/systemone` server (e.g. llama-server) can replace the hosted model.
- `pnpm-workspace.yaml` records that esbuild's install script is deliberately skipped (`allowBuilds: esbuild: false`); without it, `pnpm install` fails inside Docker. Approve or deny any new dependency's build script there too.
- ESM with `nodenext`: relative imports use the `.js` extension. `verbatimModuleSyntax` is on, so type-only imports use `import type`.
- New env vars go in `config.ts`, `.env.example` and the table in `docs/configuration.md` together.
- Manifest changes (scopes, commands, events) need the app reinstalled; say so in `docs/setup.md` when you make one.
- Planned work lives in `BACKLOG.md` (not Linear). Remove an item when it ships.

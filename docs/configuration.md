# Configuration

All settings are environment variables, read from `.env` (or the server's env file; see [setup](setup.md)).

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

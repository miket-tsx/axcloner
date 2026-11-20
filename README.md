# AXCLONER

Discord server cloner driven by a selfbot token. You point it at a source server you can read and a target server where your account has Administrator, choose what to copy, and it rebuilds the target piece by piece.

Made by axyers team (mikey).

```
./axcloner.sh          →   http://localhost:4080      (linux, macos, termux)
axcloner.bat           →   http://localhost:4080      (windows)
```

No npm install. No build step. Node 18 or newer and that is it.

---

## What it copies

| Piece | Detail |
| --- | --- |
| Server name | Optional rename of the target |
| Icon | Source icon re-uploaded |
| Description | Source description text |
| Server settings | AFK channel + timeout, system channel + flags, verification level, notification default, explicit content filter, preferred locale, banner, splash — each field only applied when the target supports it |
| Roles | Name, color, hoist, mentionable, permissions, unicode emoji, role icon, position |
| Emojis | Static and animated, downloaded and re-uploaded |
| Stickers | PNG and APNG stickers re-uploaded; Lottie stickers cannot be uploaded back through the API and are skipped |
| Soundboard | Sound files re-uploaded with their volume |
| Categories | Name, position, permission overwrites |
| Channels | Text, voice, announcement, stage, forum, media, with topic, slowmode, nsfw, bitrate, user limit, forum tags, permission overwrites and positions |
| Welcome screen | Description and recommended channels |
| Onboarding | Prompts, options, default channels, when the source has it |
| Webhooks | Incoming hooks recreated on the matching channel with their name and avatar |
| Invites | New codes on the matching channel with the same expiry and use limits |
| Scheduled events | Upcoming events only, channel references remapped, cover image re-uploaded |
| AutoMod | Rules with triggers, actions, exempt roles and exempt channels remapped |
| Bans | Re-applied on the target (message deletion window is not carried over) |
| Messages | History per selected channel, replayed through webhooks with the original author name and avatar, attachments downloaded and re-uploaded |
| Pins | Re-pins the cloned messages that were pinned in the source |

Permission overwrites are remapped from source role ids to the freshly created target role ids. `@everyone` is remapped to the target guild id. Member-level overwrites are skipped because members are not cloned.

## What it does not do

- It does not copy members, threads, or audit log entries.
- Role icons and emoji ids are rebuilt. A forum tag whose emoji was a custom emoji loses that emoji, since the id changes.
- Onboarding needs the target to have Community enabled already. If the request fails the rest of the run continues.
- Server settings are capped by Discord at a couple of edits per hour per guild. When that cap is hit the settings step is logged and skipped, and everything else still runs.

---

## Requirements

- Node.js 18.17 or newer (global `fetch`, `FormData` and `Blob` are used directly).
- A Discord user token. The account has to be a member of the source server. For the target it has to hold a role with **Administrator**, or be the owner.
- Administrator in the target is not optional. The clone refuses to start without it, which saves you a half-wiped server.

---

## Windows

1. Install the LTS build from <https://nodejs.org>. Default options are fine.
2. Double-click `axcloner.bat`. It checks the Node version, refuses to start on anything older than 18.17, clears a stuck port if you tell it to, opens the browser and runs the server.

If you prefer the manual route:

```powershell
cd C:\path\to\axcloner
node server.js
```

Then open <http://localhost:4080>.

If 4080 is busy:

```powershell
$env:PORT=4090; node server.js
```

## Linux (Debian, Ubuntu and friends)

Stock repositories usually carry an older Node. Check first.

```bash
node -v
```

If it is under 18, install from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

On distributions without apt, use nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
```

Run it with the launcher:

```bash
chmod +x axcloner.sh
./axcloner.sh
```

The launcher verifies Node, offers to free port 4080 if something is squatting on it, opens your browser and hands over to the server. Manual start still works:

```bash
cd ~/axcloner
node server.js
```

If the machine is remote, forward the port rather than exposing it:

```bash
ssh -L 4080:localhost:4080 user@host
```

## Android (Termux)

```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs
cd ~/axcloner
chmod +x axcloner.sh
./axcloner.sh
```

The launcher uses `termux-open-url` when it is present. If it is not:

```bash
pkg install -y termux-tools
```

Manual start:

```bash
node server.js
termux-open-url http://localhost:4080
```

Turn off battery optimisation for Termux before a long run. Android will otherwise kill the process when the screen locks, and the clone stops halfway through.

---

## Using it

1. **Token.** In the Discord client press `Ctrl+Shift+I`, open Network, click any request to `discord.com/api` and copy the `authorization` request header. That value is the token.
2. **Source id.** Right click the server icon, Copy Server ID. Enable Developer Mode in Discord settings if that option is missing. Member access is enough.
3. **Target id.** Same thing on the destination server. The token account needs Administrator there.
4. **Analyze source.** This is read-only. It pulls the guild, roles, channels, emojis and whether onboarding exists, and checks that the target is reachable and admin-able.
5. **Choose parts.** Everything is ticked by default except messages, pins, webhooks, invites and bans. If you enable messages pick the channels and a per-channel limit; pins only apply to messages that were cloned.
6. **Wipe target first.** Off by default. When on, it deletes every channel, every non-managed role, every emoji, every sticker and every soundboard sound in the target before writing. Roles held by the token account are protected so you do not lock yourself out.
7. **Start.** The console streams each step. Cancel stops the run at the next request boundary.

`Ctrl+Enter` starts a run from anywhere in the page.

---

## Rate limits

Discord publishes the quota on every response and AXCLONER reads all of it:

- Response headers are parsed per route: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset-After`, `X-RateLimit-Bucket`.
- Routes are grouped by the bucket hash Discord returns, plus the relevant guild or channel id, which is what Discord actually keys on. Requests to the same bucket are serialised; different buckets run in parallel.
- A `429` reads `retry_after` from the body, pauses that bucket, then retries. A `429` with `global: true` pauses every request.
- A wait longer than the configured window (60s by default) is not waited out. The bucket is released, the resource is marked as parked for the run and the clone moves on. This is what stops a single hourly guild-edit limit from freezing everything for an hour.
- Twelve requests in flight at most, spread across different buckets.
- 5xx and network failures retry with exponential backoff and jitter.
- Message replay runs several channels at once and rotates across webhooks inside each channel, which spreads the per-webhook quota. Each channel keeps its own send order.

The console shows the live request count and how many 429s were absorbed. A run with a few hundred messages on a busy route will spend most of its time waiting. That is Discord, not the tool.

## Speed

What actually moves the needle:

- Channels clone in parallel (`parallelChannels`, default 3), each with its own webhook set.
- Three webhooks per channel by default, rotated per send, so one throttled hook does not stall the channel.
- Only the messages that need it are retried. A 429 under the wait window is slept and retried in place.
- Attachments download in a six-message lookahead while earlier messages are still sending, and attachments inside one message download concurrently.
- Emoji and role icons are fetched in parallel before their create loop, so CDN latency never sits on the guild queue.
- Channel positions are patched only where Discord ignored the position sent at creation. A clean clone spends zero requests on repositioning.
- Webhook sends skip `?wait=true`. The response body was never used and the round trip is pure cost.
- Up to twelve requests in flight across buckets.

What it cannot beat is the per-route quota. A run finishes as fast as its slowest bucket allows, and nothing in the client changes that.

---

## Project layout

```
axcloner/
  axcloner.sh          launcher for linux, macos and termux
  axcloner.bat         launcher for windows
  server.js            http server, api, sse job stream
  lib/rest.js          rate limit aware discord client
  lib/cloner.js        the clone pipeline
  lib/util.js          snowflakes, cdn helpers, concurrency
  public/index.html    ui shell
  public/style.css     styling
  public/app.js        ui logic and event stream handling
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/info` | Version and endpoint list |
| `POST` | `/api/preview` | `{ token, sourceId, targetId? }` — read-only source/target inspection |
| `POST` | `/api/clone` | `{ token, sourceId, targetId, options }` — starts a job, returns `{ jobId }` |
| `GET` | `/api/stream/:jobId` | Server-sent events for that job |
| `POST` | `/api/job/:jobId/cancel` | Abort the job |

Clone options:

```json
{
  "cloneName": true,
  "cloneIcon": true,
  "cloneDescription": true,
  "cloneRoles": true,
  "cloneEmojis": true,
  "cloneStickers": true,
  "cloneSoundboard": true,
  "cloneCategories": true,
  "cloneChannels": true,
  "cloneSettings": true,
  "cloneWelcome": true,
  "cloneOnboarding": true,
  "cloneWebhooks": false,
  "cloneInvites": false,
  "cloneEvents": true,
  "cloneAutomod": true,
  "cloneBans": false,
  "cloneMessages": false,
  "clonePins": false,
  "messageChannels": ["123456789012345678"],
  "messageLimit": 50,
  "webhookCount": 3,
  "parallelChannels": 3,
  "rateLimitWaitSeconds": 60,
  "deleteWebhooks": true,
  "deleteExisting": false
}
```

## Notes

- Tokens live in the process memory for the length of a request. Nothing is written to disk, no database, no logs on the server side.
- The server binds `0.0.0.0` by default so it also works from a phone on the same network. If you only ever use it locally, start it with `HOST=127.0.0.1 node server.js`.
- Selfbot use breaks Discord's terms of service. That is your call, and it is the reason the tool never asks for a bot token: bot accounts cannot do any of this.
- `DELETE` of a role the token cannot reach fails with 403 and is logged. The run continues.

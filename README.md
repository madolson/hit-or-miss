# Hit or Miss

A live multiple-choice race. Players scan a Valkey-branded QR code on the host screen, pick a name, and play from their phone. Each question runs 30 seconds: answer blind in the first 20 for the question's full points, then everyone's guesses show and points fall linearly to 0 at 30 seconds. Wrong answers score 0. The host clicks **Next question** to start each one. The first question is a zero-point warm-up.

All state lives in Valkey. Every command Valkey executes, captured with `MONITOR`, is appended to the `valkey:commands` stream and shown live on the host screen and at `/commands`.

## Pages

| Path | Who |
|---|---|
| `/play` | Players (the QR target). The `pid` cookie keeps a player's identity and score across rounds and reloads. **Leave** removes the player. |
| `/host` | Big screen. Asks for the admin code before showing the QR code (voxel hexagon mask). The admin panel drops down from the top bar over the game. Next question, Questions (lists questions and answers from Valkey), Reset game (clears players, scores and rounds), Reset trivia (clears every trivia score and attempt), Log out. |
| `/trivia` | Self-paced version of the same questions. The server grades each answer, so answers never reach the browser before you pick. The first answer to each question sticks. At the end you get a shareable 🟩🟥 card and can submit your score with a name, once. The results page lists every submitted score. The `tid` cookie is the one attempt, so clearing cookies is the only way to retry. Emoji reactions float across every open trivia page. |
| `/commands` | Command stream and commands/s gauge only. |
| `/how` | One card per use case with the Valkey commands that implement it. |

## Architecture

CloudFront (HTTPS, caching off) → ALB → 2 Fargate tasks (ARM64, Node 22) → ElastiCache Valkey 9.1, cluster mode with one shard (1 primary, 1 replica), Multi-AZ, `Durability: sync`, TLS, `cache.m7g.large`. Durability requires cluster mode and isn't supported on `t4g`. Browsers get updates over Server-Sent Events. Each task tails the `game:events` stream with `XREAD BLOCK` and fans out to its own browsers, so any task can serve any player.

Round timing uses Valkey `TIME` as the single clock. Each task schedules its own 5s reveal and 15s end off the round's start time.

### Valkey keys

Every game key carries the `{game}` hash tag, so they share one cluster slot. Joining, leaving and resetting are each one atomic transaction, and reset is a single `DEL`.

| Key | Type | Purpose |
|---|---|---|
| `{game}:players` | hash | pid → name |
| `{game}:leaderboard` | zset | pid → total points, set outright from the per-question points when each question ends |
| `{game}:round` | hash | current question `n`, `start`, `qi` |
| `{game}:active` | string | `SET NX PX` lock so a question can't be restarted mid-play |
| `{game}:reactions` | stream | emoji reactions (`kind`, `pid`), read by host screens once a second |
| `{game}:reaction-counts` | hash | pid → emoji sent, incremented in the same `MULTI` as the reaction's `XADD` |
| `{game}:events` | stream | round / guess / players / reset events fanned out to every task |
| `{game}:round:<n>:answers` | hash | pid → `choice:elapsedMs`. A Lua script does `HSETNX` and the guess `XADD` atomically, so lock-in is first-write-wins |
| `{game}:round:<n>:points` | hash | pid → points, derived from the answers when the question ends |
| `{trivia}:answers:<tid>` | hash | question index → choice, `HSETNX` so the first answer sticks |
| `{trivia}:leaderboard` | zset | tid → score, `ZADD NX` so a score is submitted once |
| `{trivia}:names` | hash | tid → name, set in the same `MULTI` as the score |
| `{trivia}:reactions` | stream | trivia emoji reactions (`kind`), read by every trivia page once a second |
| `{questions}` | list | question bank (`q`, `options`, `answer` or null, `points`, `explain` shown once answered), loaded from `app/questions.json` whenever its hash changes |
| `{questions}:version` | string | that hash |
| `valkey:commands` | stream | every command executed, capped at ~5000 |
| `monitor:leader` | string | 10s lease. Only the holder runs `MONITOR`, so entries aren't duplicated per task |

Every write is either guarded (`NX`, `HSETNX`, a lock) or absolute (`HSET`, `ZADD`, `DEL`), so a client resend after a reconnect can't double-apply. There is no `INCR` or `ZINCRBY`. The one increment is the emoji count, which counts events and moves in the same transaction as the event it counts. Points are never written mid-question, so the projected command stream doesn't show who answered correctly. Commands that touch `valkey:commands` are left out of the stream. Otherwise each entry would produce another one.

## Run locally in containers

```bash
HOST_KEY=dev docker compose up --build
```

Open http://localhost:8080/host and enter `dev`. The QR code encodes whatever address the host page was opened at, so for phones on the same network open the host page at your machine's LAN address instead of `localhost`.

## Run locally without containers

```bash
valkey-server --port 6391 --cluster-enabled yes --cluster-announce-ip 127.0.0.1 --save '' &
valkey-cli -p 6391 cluster addslotsrange 0 16383
cd app && npm ci
VALKEY_PORT=6391 HOST_KEY=dev node server.js        # http://localhost:8080/host
node ../test/sim.mjs dev http://localhost:8080       # end-to-end check, ~16s
node ../test/trivia.mjs http://localhost:8080        # trivia check
node ../test/load.mjs http://localhost:8080 500 60   # 500 trivia users, 60s. Reset trivia afterwards
```

`test/sim.mjs` takes several base URLs and spreads players across them. Run two servers on different `PORT`s to check that state is shared.

## Deploy

```bash
cd infra && npm ci
npx cdk deploy --profile <your-profile>
```

Outputs are `HostUrl` and `HostKeyCommand`, which prints the host key. Tear down with `npx cdk destroy`.

Edit `app/questions.json` and redeploy to change the questions. The research questions' numbers were measured on 2026-10-03.

# Valkey Race

A live multiple-choice race. Players scan a Valkey-branded QR code on the host screen, pick a name, and play from their phone. Each question runs 30 seconds: read for 10, answer blind for the next 10 for the question's full points, then everyone's guesses show and points fall linearly to 0 at 30 seconds. Wrong answers score 0. The host clicks **Next question** to start each one. The first question is a zero-point warm-up.

All state lives in Valkey. Every command Valkey executes, captured with `MONITOR`, is appended to the `valkey:commands` stream and shown live on the host screen and at `/commands`.

## Pages

| Path | Who |
|---|---|
| `/play` | Players (the QR target). The `pid` cookie keeps a player's identity and score across rounds and reloads. **Leave** removes the player. |
| `/host` | Big screen. Asks for the admin code before showing the QR code. Next question, Questions (lists questions and answers from Valkey), Reset game (clears players, scores and rounds), Log out. |
| `/commands` | Command stream and commands/s gauge only. |

## Architecture

ALB → 2 Fargate tasks (ARM64, Node 22) → ElastiCache Valkey 9.1, cluster mode with one shard (1 primary, 1 replica), Multi-AZ, `Durability: sync`, TLS, `cache.m7g.large`. Durability requires cluster mode and isn't supported on `t4g`. Browsers get updates over Server-Sent Events. Each task tails the `game:events` stream with `XREAD BLOCK` and fans out to its own browsers, so any task can serve any player.

Round timing uses Valkey `TIME` as the single clock. Each task schedules its own 5s reveal and 15s end off the round's start time.

### Valkey keys

| Key | Type | Purpose |
|---|---|---|
| `players` | hash | pid → name |
| `leaderboard` | zset | pid → total points |
| `game:round:n` | string | round counter |
| `game:round` | hash | current round `n`, `start`, `qi` |
| `game:active` | string | `SET NX PX` lock so a round can't be restarted mid-play |
| `game:events` | stream | round / guess / join events fanned out to every task |
| `round:<n>:answers` | hash | pid → choice. `HSETNX` makes lock-in final |
| `round:<n>:points` | hash | pid → points |
| `{questions}` | list | question bank (`q`, `options`, `answer` or null, `points`), loaded from `app/questions.json` whenever its hash changes |
| `{questions}:version` | string | that hash |
| `valkey:commands` | stream | every command executed, capped at ~5000 |
| `monitor:leader` | string | 10s lease. Only the holder runs `MONITOR`, so entries aren't duplicated per task |

Commands that touch `valkey:commands` are left out of the stream. Otherwise each entry would produce another one.

## Run locally

```bash
valkey-server --port 6391 --cluster-enabled yes --cluster-announce-ip 127.0.0.1 --save '' &
valkey-cli -p 6391 cluster addslotsrange 0 16383
cd app && npm ci
VALKEY_PORT=6391 HOST_KEY=dev node server.js        # http://localhost:8080/host
node ../test/sim.mjs dev http://localhost:8080       # end-to-end check, ~16s
```

`test/sim.mjs` takes several base URLs and spreads players across them. Run two servers on different `PORT`s to check that state is shared.

## Deploy

```bash
cd infra && npm ci
npx cdk deploy --profile <your-profile>
```

Outputs are `HostUrl` and `HostKeyCommand`, which prints the host key. Tear down with `npx cdk destroy`.

Edit `app/questions.json` and redeploy to change the questions. The research questions' numbers were measured on 2026-10-03.

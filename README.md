# Valkey Race

A live multiple-choice race. Players scan a Valkey-branded QR code on the host screen, pick a name, and play rounds from their phone. Lock in within 5 seconds for 5000 points. After 5 seconds everyone's guesses become visible and points fall linearly to 0 at 15 seconds. Wrong answers score 0. The host clicks **Next round** to start each round.

All state lives in Valkey. Every command Valkey executes, captured with `MONITOR`, is appended to the `valkey:commands` stream and shown live on the host screen and at `/commands`.

## Pages

| Path | Who |
|---|---|
| `/play` | Players (the QR target). The `pid` cookie keeps a player's identity and score across rounds and reloads. |
| `/host` | Big screen: QR code, question, guesses, leaderboard, command stream. Prompts for the host key once. |
| `/commands` | Command stream only. |

## Architecture

ALB → 2 Fargate tasks (ARM64, Node 22) → ElastiCache Valkey 9.1 replication group with 1 primary and 1 replica, Multi-AZ, `Durability: sync`, TLS. Browsers get updates over Server-Sent Events. Each task tails the `game:events` stream with `XREAD BLOCK` and fans out to its own browsers, so any task can serve any player.

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
| `questions` | list | question bank, seeded from `app/questions.json` on first start |
| `valkey:commands` | stream | every command executed, capped at ~5000 |
| `monitor:leader` | string | 10s lease. Only the holder runs `MONITOR`, so entries aren't duplicated per task |

Commands that touch `valkey:commands` are left out of the stream. Otherwise each entry would produce another one.

## Run locally

```bash
valkey-server --port 6391 --save '' &
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

There is no reset endpoint. Scores and the question bank persist until the Valkey data is flushed. Questions are seeded once, so edits to `questions.json` take effect only after `questions` and `questions:seeded` are deleted.

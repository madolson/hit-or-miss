import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { client, primaryOf, monitor as startMonitor, COMMAND_STREAM } from './valkey.js';

// A round: answer blind 0-20s, answer with guesses shown 20-30s.
const REVEAL_MS = 20000;
const ROUND_MS = 30000;
const PORT = Number(process.env.PORT || 8080);
const HOST_KEY = process.env.HOST_KEY || 'dev';

const K = {
  players: 'players',          // hash pid -> name
  board: 'leaderboard',        // zset pid -> total points
  roundN: 'game:round:n',      // counter
  round: 'game:round',         // hash n, start, qi of the current round
  active: 'game:active',       // lock held while a round runs
  events: 'game:events',       // stream fanned out to every server
  questions: '{questions}',    // list of JSON questions
  questionsVersion: '{questions}:version', // hash of the questions.json they came from
  answers: (n) => `round:${n}:answers`, // hash pid -> choice
  points: (n) => `round:${n}:points`,   // hash pid -> points
  monitorLeader: 'monitor:leader',      // lease: which task runs MONITOR
};

const db = client();
const eventsReader = client();   // dedicated connections for blocking XREAD
const commandsReader = client();
const logger = client();         // writes MONITOR output to the command stream

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fields(arr) {
  const o = {};
  for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  return o;
}

// Full points until guesses are revealed, then linear down to 0 at the end.
function points(elapsed, max) {
  if (elapsed <= REVEAL_MS) return max;
  return Math.max(0, Math.round((max * (ROUND_MS - elapsed)) / (ROUND_MS - REVEAL_MS)));
}

async function now() {
  const [s, us] = await db.time();
  return Number(s) * 1000 + Math.floor(Number(us) / 1000);
}

// Load questions.json into Valkey whenever its contents change.
async function seed() {
  const raw = fs.readFileSync(path.join(import.meta.dirname, 'questions.json'), 'utf8');
  const version = crypto.createHash('sha1').update(raw).digest('hex');
  if ((await db.get(K.questionsVersion)) === version) return;
  const qs = JSON.parse(raw).map((q) => JSON.stringify(q));
  // Same hash tag, so one slot and one atomic transaction.
  await db.multi().del(K.questions).rpush(K.questions, ...qs).set(K.questionsVersion, version).exec();
}

async function getRound() {
  const r = await db.hgetall(K.round);
  return r.n ? { n: Number(r.n), start: Number(r.start), qi: Number(r.qi) } : null;
}

const question = async (qi) => JSON.parse(await db.lindex(K.questions, qi));

async function names(pids) {
  if (!pids.length) return {};
  const vals = await db.hmget(K.players, ...pids);
  return Object.fromEntries(pids.map((p, i) => [p, vals[i]]));
}

async function guesses(n) {
  const answers = await db.hgetall(K.answers(n));
  const nm = await names(Object.keys(answers));
  return Object.entries(answers).map(([pid, c]) => ({ pid, name: nm[pid], choice: Number(c) }));
}

async function leaderboard() {
  const flat = await db.zrevrange(K.board, 0, -1, 'WITHSCORES');
  const pids = flat.filter((_, i) => i % 2 === 0);
  const nm = await names(pids);
  return pids.map((pid, i) => ({ pid, name: nm[pid], score: Number(flat[i * 2 + 1]), rank: i + 1 }));
}

// ---- Server-sent events to browsers connected to this process ----

const clients = new Set();

function send(c, type, data) {
  c.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(type, data, filter = () => true) {
  for (const c of clients) if (filter(c)) send(c, type, data);
}

setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 15000);

// ---- Round timeline. Every process runs its own timers off the round start. ----

let scheduledRound = 0;
let revealedRound = 0;
let epoch = 0; // bumped on game reset so timers from before it do nothing

function schedule(r) {
  if (r.n <= scheduledRound) return;
  scheduledRound = r.n;
  const e = epoch;
  const at = (ms, fn) => setTimeout(() => { if (e === epoch) fn().catch(console.error); }, r.start + ms - Date.now());
  at(REVEAL_MS, () => reveal(r.n));
  at(ROUND_MS + 250, () => endRound(r));
}

async function reveal(n) {
  // Set before reading so guesses committed after the read still go out live.
  revealedRound = n;
  broadcast('reveal', { n, guesses: await guesses(n) });
}

async function endRound(r) {
  const [q, pts, board, total] = await Promise.all([
    question(r.qi), db.hgetall(K.points(r.n)), leaderboard(), db.llen(K.questions)]);
  const byPid = Object.fromEntries(board.map((e) => [e.pid, e]));
  const top = board.slice(0, 10);
  for (const c of clients) {
    send(c, 'end', {
      n: r.n, correct: q.answer, top, final: r.n === total,
      me: c.pid ? { points: Number(pts[c.pid] ?? 0), answered: c.pid in pts, ...byPid[c.pid] } : null,
    });
  }
}

async function onEvent(e) {
  if (e.type === 'round') {
    const r = { n: Number(e.n), start: Number(e.start), qi: Number(e.qi) };
    schedule(r);
    broadcast('round', { n: r.n, start: r.start, serverNow: Date.now(), ...JSON.parse(e.question) });
  } else if (e.type === 'guess') {
    if (revealedRound >= Number(e.n)) {
      broadcast('guess', { n: Number(e.n), pid: e.pid, name: e.name, choice: Number(e.choice) });
    }
  } else if (e.type === 'players') {
    broadcast('players', { count: Number(e.count) });
  } else if (e.type === 'reset') {
    epoch++;
    scheduledRound = revealedRound = 0;
    broadcast('reset', {});
  }
}

async function tailEvents() {
  const last = await db.xrevrange(K.events, '+', '-', 'COUNT', 1);
  let id = last[0]?.[0] ?? '0-0';
  for (;;) {
    try {
      const res = await eventsReader.xread('BLOCK', 0, 'STREAMS', K.events, id);
      for (const [, entries] of res ?? []) {
        for (const [eid, f] of entries) {
          id = eid;
          await onEvent(fields(f)).catch(console.error);
        }
      }
    } catch (err) {
      console.error('events:', err.message);
      await sleep(1000);
    }
  }
}

// ---- Command stream. One task at a time holds the lease and runs MONITOR. ----

const SRC = crypto.randomUUID(); // lease owner id for this process
const LEASE_MS = 10000;
const RENEW = "if server.call('GET', KEYS[1]) == ARGV[1] then return server.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0";
let monitor = null; // { conn, addr } of the MONITOR connection

function fmt(args) {
  const s = args.join(' ');
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

function stopMonitor() {
  monitor?.conn.disconnect();
  monitor = null;
}

async function leadMonitor() {
  for (;;) {
    try {
      const lead = (await db.set(K.monitorLeader, SRC, 'PX', LEASE_MS, 'NX'))
        || (await db.eval(RENEW, 1, K.monitorLeader, SRC, LEASE_MS));
      const primary = primaryOf(db);
      const addr = `${primary.options.host}:${primary.options.port}`;
      // Drop the lease, or follow the primary after a failover.
      if (monitor && (!lead || monitor.addr !== addr)) stopMonitor();
      if (lead && !monitor) {
        const conn = await startMonitor(primary);
        monitor = { conn, addr };
        conn.on('monitor', (time, args, source) => {
          // Skip traffic on the stream itself, or every entry would log another.
          if (args.includes(COMMAND_STREAM)) return;
          logger.xadd(COMMAND_STREAM, 'MAXLEN', '~', 5000, '*',
            'src', source, 'cmd', args[0].toUpperCase(), 'args', fmt(args.slice(1))).catch(() => {});
        });
        conn.on('end', () => { if (monitor?.conn === conn) monitor = null; });
      }
    } catch (err) {
      console.error('monitor:', err.message);
    }
    await sleep(LEASE_MS / 3);
  }
}

const toCmd = ([id, f]) => ({ id, ...fields(f) });

async function tailCommands() {
  let id = '$';
  for (;;) {
    try {
      const res = await commandsReader.xread('BLOCK', 0, 'COUNT', 500, 'STREAMS', COMMAND_STREAM, id);
      for (const [, entries] of res ?? []) {
        id = entries[entries.length - 1][0];
        broadcast('cmds', entries.map(toCmd), (c) => c.cmds);
      }
    } catch (err) {
      console.error('commands:', err.message);
      await sleep(1000);
    }
  }
}

// ---- HTTP ----

async function state(pid) {
  const [r, count, board, total] = await Promise.all([getRound(), db.hlen(K.players), leaderboard(), db.llen(K.questions)]);
  const me = pid ? board.find((e) => e.pid === pid) ?? null : null;
  const out = { serverNow: Date.now(), players: count, top: board.slice(0, 10), me, total, round: null };
  if (r) {
    const q = await question(r.qi);
    const elapsed = Date.now() - r.start;
    out.round = { n: r.n, start: r.start, q: q.q, options: q.options, points: q.points };
    if (pid) out.round.myChoice = (await db.hget(K.answers(r.n), pid)) ?? null;
    if (elapsed >= REVEAL_MS) out.round.guesses = await guesses(r.n);
    if (elapsed >= ROUND_MS) {
      out.round.ended = true;
      out.round.correct = q.answer;
      if (pid && me) {
        const p = await db.hget(K.points(r.n), pid);
        out.round.me = { points: Number(p ?? 0), answered: p !== null, ...me };
      }
    }
  }
  return out;
}

async function join(pid, body) {
  const name = String(body.name ?? '').trim().slice(0, 20);
  if (!name) return [400, { error: 'name required' }];
  pid ||= crypto.randomUUID();
  await db.hset(K.players, pid, name);
  await db.zadd(K.board, 'NX', 0, pid);
  const count = await db.hlen(K.players);
  await db.xadd(K.events, 'MAXLEN', '~', 1000, '*', 'type', 'players', 'count', count);
  return [200, { pid, name }, `pid=${pid}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly`];
}

async function leave(pid) {
  if (pid) {
    await db.hdel(K.players, pid);
    await db.zrem(K.board, pid);
    const count = await db.hlen(K.players);
    await db.xadd(K.events, 'MAXLEN', '~', 1000, '*', 'type', 'players', 'count', count);
  }
  return [200, { ok: true }, 'pid=; Path=/; Max-Age=0'];
}

async function answer(pid, body) {
  const name = pid && (await db.hget(K.players, pid));
  if (!name) return [401, { error: 'join first' }];
  const n = Number(body.n);
  const choice = Number(body.choice);
  if (![0, 1, 2, 3].includes(choice)) return [400, { error: 'bad choice' }];
  const r = await getRound();
  if (!r || r.n !== n) return [409, { error: 'not the current round' }];
  const elapsed = (await now()) - r.start;
  if (elapsed >= ROUND_MS) return [409, { error: 'round over' }];
  if (!(await db.hsetnx(K.answers(n), pid, choice))) return [409, { error: 'already locked in' }];
  const q = await question(r.qi);
  const pts = choice === q.answer ? points(elapsed, q.points) : 0;
  await Promise.all([
    db.hset(K.points(n), pid, pts),
    db.zincrby(K.board, pts, pid),
    db.xadd(K.events, 'MAXLEN', '~', 1000, '*', 'type', 'guess', 'n', n, 'pid', pid, 'name', name, 'choice', choice),
  ]);
  return [200, { ok: true, elapsed }];
}

const DENIED = [403, { error: 'bad host key' }];

async function next() {
  if (!(await db.set(K.active, '1', 'PX', ROUND_MS + 1000, 'NX'))) return [409, { error: 'round in progress' }];
  const total = await db.llen(K.questions);
  if (Number((await db.get(K.roundN)) ?? 0) >= total) {
    await db.del(K.active);
    return [409, { error: 'no more questions. Reset to play again' }];
  }
  const n = await db.incr(K.roundN);
  const qi = n - 1;
  const q = await question(qi);
  const start = await now();
  await db.hset(K.round, { n, start, qi });
  await db.xadd(K.events, 'MAXLEN', '~', 1000, '*', 'type', 'round', 'n', n, 'start', start, 'qi', qi,
    'question', JSON.stringify({ q: q.q, options: q.options, points: q.points, total }));
  return [200, { n }];
}

async function reset() {
  const n = Number((await db.get(K.roundN)) ?? 0);
  const keys = [K.players, K.board, K.roundN, K.round, K.active];
  for (let i = 1; i <= n; i++) keys.push(K.answers(i), K.points(i));
  // One DEL per key: in cluster mode a multi-key DEL must stay within one slot.
  await Promise.all(keys.map((k) => db.del(k)));
  await db.xadd(K.events, 'MAXLEN', '~', 1000, '*', 'type', 'reset');
  return [200, { ok: true }];
}

async function questions() {
  return [200, (await db.lrange(K.questions, 0, -1)).map((q) => JSON.parse(q))];
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const PUBLIC = path.join(import.meta.dirname, 'public');
const files = Object.fromEntries(fs.readdirSync(PUBLIC).map((f) => [f, fs.readFileSync(path.join(PUBLIC, f))]));
const PAGES = { '/play': 'play.html', '/host': 'host.html', '/commands': 'commands.html' };

function cookiePid(req) {
  const m = /(?:^|;\s*)pid=([0-9a-f-]{36})/.exec(req.headers.cookie ?? '');
  return m?.[1];
}

async function readJson(req) {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 4096) throw new Error('body too large');
  }
  return s ? JSON.parse(s) : {};
}

function json(res, status, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Set-Cookie'] = cookie;
  res.writeHead(status, headers).end(JSON.stringify(body));
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const pid = cookiePid(req);
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /healthz') return res.writeHead(200).end('ok');
  if (route === 'GET /') return res.writeHead(302, { Location: '/play' }).end();

  const file = PAGES[url.pathname] ?? url.pathname.slice(1);
  if (req.method === 'GET' && files[file]) {
    return res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(files[file]);
  }

  if (route === 'GET /events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const c = { res, pid, cmds: url.searchParams.has('commands') };
    clients.add(c);
    req.on('close', () => clients.delete(c));
    if (c.cmds) send(c, 'cmds', (await logger.xrevrange(COMMAND_STREAM, '+', '-', 'COUNT', 100)).reverse().map(toCmd));
    return;
  }

  if (route === 'GET /api/state') return json(res, 200, await state(pid));
  if (route === 'POST /api/join') return json(res, ...(await join(pid, await readJson(req))));
  if (route === 'POST /api/answer') return json(res, ...(await answer(pid, await readJson(req))));
  if (route === 'POST /api/leave') return json(res, ...(await leave(pid)));

  if (url.pathname.startsWith('/api/host/')) {
    if (req.headers['x-host-key'] !== HOST_KEY) return json(res, ...DENIED);
    if (route === 'POST /api/host/login') return json(res, 200, { ok: true });
    if (route === 'GET /api/host/questions') return json(res, ...(await questions()));
    if (route === 'POST /api/host/next') return json(res, ...(await next()));
    if (route === 'POST /api/host/reset') return json(res, ...(await reset()));
  }

  res.writeHead(404).end('not found');
}

await seed();
const current = await getRound();
if (current) schedule(current);
tailEvents();
tailCommands();
leadMonitor();
http.createServer((req, res) => handle(req, res).catch((err) => {
  console.error(err);
  if (!res.headersSent) json(res, 500, { error: 'internal error' });
})).listen(PORT, () => console.log(`listening on :${PORT}`));

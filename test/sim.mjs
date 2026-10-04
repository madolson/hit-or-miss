// End-to-end check against running servers.
// Usage: node test/sim.mjs <hostKey> <baseUrl> [<baseUrl> ...]
// Players are spread across the base URLs to prove state is shared through Valkey.
import assert from 'node:assert/strict';

const [hostKey, ...bases] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

class Player {
  constructor(name, base) { this.name = name; this.base = base; this.cookie = ''; this.events = []; }
  async req(path, body, headers = {}) {
    const res = await fetch(this.base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Cookie: this.cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return [res.status, await res.json()];
  }
  // Minimal SSE reader; records [elapsedMs, type, data].
  async listen(query = '') {
    const res = await fetch(`${this.base}/events${query}`, { headers: { Cookie: this.cookie } });
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const msg = buf.slice(0, i); buf = buf.slice(i + 2);
          const type = /^event: (.*)$/m.exec(msg)?.[1];
          const data = /^data: (.*)$/m.exec(msg)?.[1];
          if (type) this.events.push([Date.now(), type, JSON.parse(data)]);
        }
      }
    })();
  }
}

const base = (i) => bases[i % bases.length];
const [alice, bob, carol, dan] = ['alice', 'bob', 'carol', 'dan'].map((n, i) => new Player(n, base(i)));
const host = new Player('host', base(1));
const hostReq = (path, key = hostKey) => host.req(path, {}, { 'x-host-key': key });
const questions = (await import('../app/questions.json', { with: { type: 'json' } })).default;

assert.equal((await hostReq('/api/host/login', 'wrong'))[0], 403);
assert.equal((await hostReq('/api/host/reset'))[0], 200);
const [, qs] = await host.req('/api/host/questions', null, { 'x-host-key': hostKey });
assert.deepEqual(qs, questions, 'questions in Valkey match questions.json');

for (const p of [alice, bob, carol, dan]) assert.equal((await p.req('/api/join', { name: p.name }))[0], 200);
for (const p of [alice, bob, carol, dan]) await p.listen();
await host.listen('?commands');
await sleep(300);

// Join and leave events carry the player, so the host board can change right away.
const erin = new Player('erin', base(0));
await erin.req('/api/join', { name: 'erin' });
const [, erinState] = await erin.req('/api/state');
await erin.req('/api/leave', {});
await sleep(300);
assert.ok(host.events.some(([, t, d]) => t === 'players' && d.name === 'erin' && !d.left), 'host told erin joined');
assert.ok(host.events.some(([, t, d]) => t === 'players' && d.pid === erinState.me.pid && d.left), 'host told erin left');

// Reactions: the host reads everything after the last id it saw.
const [, start0] = await host.req('/api/reactions');
assert.equal((await bob.req('/api/react', { kind: 'heart' }))[0], 200);
assert.equal((await bob.req('/api/react', { kind: 'valkey' }))[0], 200);
assert.equal((await bob.req('/api/react', { kind: 'nope' }))[0], 400);
const [, got] = await host.req(`/api/reactions?after=${start0.last}`);
assert.deepEqual(got.items.map((x) => x.kind), ['heart', 'valkey']);
const [, bobState] = await bob.req('/api/state');
assert.equal(bobState.me.reactions, 2, 'leaderboard counts bob\'s emoji');
const [, again0] = await host.req(`/api/reactions?after=${got.last}`);
assert.deepEqual(again0.items, [], 'nothing new since the last id');

async function startRound() {
  const [code, nx] = await hostReq('/api/host/next');
  assert.equal(code, 200, JSON.stringify(nx));
  assert.equal((await hostReq('/api/host/next'))[0], 409, 'next during a round');
  await sleep(300);
  const ev = alice.events.find(([, t, d]) => t === 'round' && d.n === nx.n);
  assert.ok(ev, 'alice got round start');
  return { n: nx.n, start: ev[2].start };
}
const at = (r, ms) => sleep(r.start + ms - Date.now());

// Round 1: the zero-point warm-up.
let r = await startRound();
assert.equal(r.n, 1);
assert.equal((await alice.req('/api/answer', { n: r.n, choice: 0 }))[0], 200);
await at(r, 31500);
const warm = alice.events.find(([, t, d]) => t === 'end' && d.n === r.n)[2];
assert.equal(warm.correct, null);
assert.equal(warm.me.points, 0);
log('warm-up ok');

// Round 2: the second warm-up.
r = await startRound();
assert.equal(questions[r.n - 1].answer, null);
await at(r, 31500);
assert.equal(alice.events.find(([, t, d]) => t === 'end' && d.n === r.n)[2].correct, null);

// Round 3: scored.
r = await startRound();
const q = questions[r.n - 1];
const right = q.answer;
const wrong = (right + 1) % 4;
log(`round ${r.n}: ${q.q} -> ${q.options[right]} (${q.points} pts)`);
const [, ra] = await alice.req('/api/answer', { n: r.n, choice: right });
assert.equal((await alice.req('/api/answer', { n: r.n, choice: right }))[0], 409, 'double lock-in');
assert.equal((await bob.req('/api/answer', { n: r.n, choice: wrong }))[0], 200);
await at(r, 25000);
const [, rc] = await carol.req('/api/answer', { n: r.n, choice: right });
log(`alice locked at ${ra.elapsed}ms, carol at ${rc.elapsed}ms`);
await at(r, 31000);
assert.equal((await dan.req('/api/answer', { n: r.n, choice: right }))[0], 409, 'answer after 30s');

// Guesses must not reach anyone before the 20s reveal.
for (const p of [alice, bob, carol, dan]) {
  const early = p.events.filter(([ts, t, d]) => (t === 'guess' || t === 'reveal') && d.n === r.n && ts < r.start + 20000 - 50);
  assert.equal(early.length, 0, `${p.name} saw guesses before 20s`);
  const rev = p.events.find(([, t, d]) => t === 'reveal' && d.n === r.n);
  assert.deepEqual(rev[2].guesses.map((g) => g.name).sort(), ['alice', 'bob']);
  assert.ok(p.events.some(([, t, d]) => t === 'guess' && d.n === r.n && d.name === 'carol'), `${p.name} saw carol live`);
}

const expectCarol = Math.round((q.points * (30000 - rc.elapsed)) / 10000);
const ends = Object.fromEntries([alice, bob, carol, dan].map((p) => [p.name, p.events.find(([, t, d]) => t === 'end' && d.n === r.n)[2]]));
assert.equal(ends.alice.correct, right);
assert.equal(ends.alice.me.points, q.points);
assert.equal(ends.bob.me.points, 0);
assert.equal(ends.carol.me.points, expectCarol);
assert.equal(ends.dan.me.answered, false);
log('points', Object.fromEntries(Object.entries(ends).map(([k, v]) => [k, v.me.points])));

// Sticky session: a fresh state call with the same cookie knows the player.
const [, again] = await carol.req('/api/state');
assert.equal(again.me.name, 'carol');

const cmds = host.events.filter(([, t]) => t === 'cmds').flatMap(([, , d]) => d);
const names = new Set(cmds.map((c) => c.cmd));
for (const c of ['HSETNX', 'ZADD', 'TIME', 'XREAD', 'SET', 'EVAL', 'MULTI']) assert.ok(names.has(c), `command stream has ${c}`);
for (const c of ['ZINCRBY', 'INCR']) assert.ok(!names.has(c), `non-idempotent ${c} is gone`);
// Points are written only once the question ends, so the stream can't give away who was right.
const early = cmds.filter((c) => c.cmd === 'HSET' && c.args.startsWith(`{game}:round:${r.n}:points`) && Number(c.id.split('-')[0]) < r.start + 30000);
assert.equal(early.length, 0, 'points written before the question ended');
assert.ok(cmds.some((c) => c.cmd === 'EVAL' && c.args.includes('server.call')), 'lease script uses server.call');
assert.ok(!cmds.some((c) => c.args.includes('valkey:commands')), 'command stream logs itself');
// alice twice, bob, carol. More means two servers are both running MONITOR.
assert.equal(cmds.filter((c) => c.cmd === 'HSETNX' && c.args.startsWith(`{game}:round:${r.n}:answers`)).length, 4);

// Leaving removes the player and clears the cookie.
await dan.req('/api/leave', {});
const [, afterLeave] = await alice.req('/api/state');
assert.equal(afterLeave.players, 3);
const [, danState] = await dan.req('/api/state');
assert.equal(danState.me, null);

// Reset clears everyone and starts over at the warm-up.
assert.equal((await hostReq('/api/host/reset'))[0], 200);
await sleep(300);
assert.ok(alice.events.some(([, t]) => t === 'reset'), 'alice told about reset');
const [, fresh] = await alice.req('/api/state');
assert.equal(fresh.players, 0);
assert.equal(fresh.round, null);
assert.equal(fresh.me, null);
assert.equal((await startRound()).n, 1, 'first question after reset is the warm-up');
await hostReq('/api/host/reset');
log(`ok: ${cmds.length} commands streamed, kinds: ${[...names].sort().join(' ')}`);
process.exit(0);

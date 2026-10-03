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

for (const p of [alice, bob, carol, dan]) assert.equal((await p.req('/api/join', { name: p.name }))[0], 200);
for (const p of [alice, bob, carol, dan]) await p.listen();
await host.listen('?commands');
await sleep(300);

assert.equal((await host.req('/api/next', {}, { 'x-host-key': 'wrong' }))[0], 403);
const [code, nx] = await host.req('/api/next', {}, { 'x-host-key': hostKey });
assert.equal(code, 200);
const n = nx.n;
assert.equal((await host.req('/api/next', {}, { 'x-host-key': hostKey }))[0], 409, 'next during a round');
await sleep(200);

const roundEv = alice.events.find(([, t, d]) => t === 'round' && d.n === n);
assert.ok(roundEv, 'alice got round start');
const start = roundEv[2].start;
const [, st] = await alice.req('/api/state');
const q = (await import('../app/questions.json', { with: { type: 'json' } })).default
  .find((x) => x.q === st.round.q);
const right = q.answer;
const wrong = (right + 1) % 4;
log(`round ${n}: ${q.q} -> ${q.options[right]}`);

const [ca, ra] = await alice.req('/api/answer', { n, choice: right });
assert.equal(ca, 200);
assert.equal((await alice.req('/api/answer', { n, choice: right }))[0], 409, 'double lock-in');
assert.equal((await bob.req('/api/answer', { n, choice: wrong }))[0], 200);
await sleep(start + 10000 - Date.now());
const [, rc] = await carol.req('/api/answer', { n, choice: right });
log(`alice locked at ${ra.elapsed}ms, carol at ${rc.elapsed}ms`);
await sleep(start + 15500 - Date.now());
assert.equal((await dan.req('/api/answer', { n, choice: right }))[0], 409, 'answer after 15s');

// Guesses must not reach anyone before the 5s reveal.
for (const p of [alice, bob, carol, dan]) {
  const early = p.events.filter(([ts, t]) => (t === 'guess' || t === 'reveal') && ts < start + 5000 - 50);
  assert.equal(early.length, 0, `${p.name} saw guesses before 5s`);
  const rev = p.events.find(([, t, d]) => t === 'reveal' && d.n === n);
  assert.deepEqual(rev[2].guesses.map((g) => g.name).sort(), ['alice', 'bob']);
  assert.ok(p.events.some(([, t, d]) => t === 'guess' && d.name === 'carol'), `${p.name} saw carol live`);
}

const expectCarol = Math.round((5000 * (15000 - rc.elapsed)) / 10000);
const ends = Object.fromEntries([alice, bob, carol, dan].map((p) => [p.name, p.events.find(([, t, d]) => t === 'end' && d.n === n)[2]]));
assert.equal(ends.alice.correct, right);
assert.equal(ends.alice.me.points, 5000);
assert.equal(ends.bob.me.points, 0);
assert.equal(ends.carol.me.points, expectCarol);
assert.equal(ends.dan.me.answered, false);
log('points', Object.fromEntries(Object.entries(ends).map(([k, v]) => [k, v.me.points])));

// Sticky session: a fresh state call with the same cookie knows the player.
const [, again] = await carol.req('/api/state');
assert.equal(again.me.name, 'carol');

const cmds = host.events.filter(([, t]) => t === 'cmds').flatMap(([, , d]) => d);
const names = new Set(cmds.map((c) => c.cmd));
for (const c of ['HSETNX', 'ZINCRBY', 'TIME', 'XREAD', 'SET', 'INCR']) assert.ok(names.has(c), `command stream has ${c}`);
assert.ok(!cmds.some((c) => c.args.startsWith('valkey:commands')), 'command stream logs itself');
log(`ok: ${cmds.length} commands streamed, kinds: ${[...names].sort().join(' ')}`);
process.exit(0);

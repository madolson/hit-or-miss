// Load test for /trivia: many users at once, each playing attempt after attempt the way the
// page does (state, answer every question, state, submit, state), with emoji along the way.
// Usage: node test/load.mjs <baseUrl> [users=500] [seconds=60] [thinkMs=1000]
// Every attempt lands on the trivia leaderboard. Clear it with Reset trivia on /host.
const [base, users = 500, seconds = 60, thinkMs = 1000] = process.argv.slice(2).map((a, i) => (i ? Number(a) : a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + seconds * 1000;
const lat = [];
const errors = {};
let requests = 0;
let submitted = 0;
let inflight = 0;

async function req(cookie, path, body) {
  const t = Date.now();
  inflight++;
  try {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Cookie: cookie.v },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie.v = set.split(';')[0];
    const out = await res.json();
    if (res.status !== 200) errors[res.status] = (errors[res.status] ?? 0) + 1;
    return out;
  } catch (err) {
    errors[err.cause?.code ?? err.message] = (errors[err.cause?.code ?? err.message] ?? 0) + 1;
    return null;
  } finally {
    inflight--;
    requests++;
    lat.push(Date.now() - t);
  }
}

async function user(u) {
  await sleep(Math.random() * thinkMs); // stagger the start
  for (let attempt = 1; Date.now() < deadline; attempt++) {
    const cookie = { v: '' }; // a fresh cookie is a fresh attempt
    let s = await req(cookie, '/api/trivia/state');
    while (s?.question && Date.now() < deadline) {
      await sleep(thinkMs * (0.5 + Math.random()));
      await req(cookie, '/api/trivia/answer', { i: s.n, choice: Math.floor(Math.random() * s.question.options.length) });
      if (Math.random() < 0.2) req(cookie, '/api/trivia/react', { kind: ['heart', 'thumbs', 'rocket', 'valkey'][Math.floor(Math.random() * 4)] });
      s = await req(cookie, '/api/trivia/state');
    }
    if (s && !s.question) {
      const r = await req(cookie, '/api/trivia/submit', { name: `load-${u}-${attempt}` });
      if (r?.ok) submitted++;
      await req(cookie, '/api/trivia/state');
    }
  }
}

const t0 = Date.now();
const ticker = setInterval(() => {
  const t = (Date.now() - t0) / 1000;
  console.log(`[${t.toFixed(0)}s] ${requests} requests (${(requests / t).toFixed(0)}/s), ${submitted} scores submitted, ${inflight} in flight`);
}, 5000);
await Promise.all(Array.from({ length: users }, (_, u) => user(u)));
clearInterval(ticker);

lat.sort((a, b) => a - b);
const p = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))];
const t = (Date.now() - t0) / 1000;
console.log(`${users} users, ${t.toFixed(0)}s: ${requests} requests (${(requests / t).toFixed(0)}/s), ${submitted} scores submitted`);
console.log(`latency ms: p50 ${p(0.5)}, p90 ${p(0.9)}, p99 ${p(0.99)}, max ${lat.at(-1)}`);
console.log('errors:', Object.keys(errors).length ? errors : 'none');

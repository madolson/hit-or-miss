// End-to-end check of /trivia against a running server.
// Usage: node test/trivia.mjs <baseUrl>
import assert from 'node:assert/strict';

const [base] = process.argv.slice(2);
const questions = (await import('../app/questions.json', { with: { type: 'json' } })).default;

class Visitor {
  cookie = '';
  async req(path, body) {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Cookie: this.cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return [res.status, await res.json()];
  }
}

const a = new Visitor();
const b = new Visitor();
assert.equal((await a.req('/api/trivia/answer', { i: 0, choice: 0 }))[0], 401, 'answer before the page sets a cookie');

let [, s] = await a.req('/api/trivia/state');
assert.match(a.cookie, /^tid=/);
assert.equal(s.n, 0);
assert.equal(s.total, questions.length);
assert.equal(s.question.q, questions[0].q);
assert.ok(!('answer' in s.question) && !('explain' in s.question), 'the answer is not sent before answering');
assert.equal(s.submitted, null);
assert.deepEqual(s.top, [], 'no leaderboard until you finish');

assert.equal((await a.req('/api/trivia/answer', { i: 1, choice: 0 }))[0], 409, 'skipping ahead');
assert.equal((await a.req('/api/trivia/submit', { name: 'a' }))[0], 409, 'submit before finishing');

// Right on every even question, wrong on every odd one.
let expected = 0;
for (const [i, q] of questions.entries()) {
  const right = i % 2 === 0;
  const choice = q.answer === null ? 0 : right ? q.answer : (q.answer + 1) % q.options.length;
  if (q.answer !== null && right) expected += q.points;
  const [code, r] = await a.req('/api/trivia/answer', { i, choice });
  assert.equal(code, 200);
  assert.equal(r.correct, q.answer);
  assert.equal(r.explain, q.explain);
  assert.equal(r.score, expected);
  // A second answer to the same question doesn't change it.
  assert.equal((await a.req('/api/trivia/answer', { i, choice: (choice + 1) % 4 }))[0], 409);
}

[, s] = await a.req('/api/trivia/state');
assert.equal(s.n, questions.length);
assert.equal(s.question, null);
assert.equal(s.score, expected);
assert.deepEqual(s.results, questions.map((q, i) => (q.answer === null ? null : i % 2 === 0)), 'share card');
assert.ok(s.top.every((e) => !('pid' in e) && !('tid' in e)), 'leaderboard leaks no ids');
assert.equal(s.max, questions.reduce((t, q) => t + (q.answer === null ? 0 : q.points), 0));

assert.equal((await a.req('/api/trivia/submit', { name: '  ' }))[0], 400);
const name = `t${Date.now() % 1e6}`;
assert.equal((await a.req('/api/trivia/submit', { name }))[0], 200);
assert.equal((await a.req('/api/trivia/submit', { name: 'again' }))[0], 409, 'one submission');
[, s] = await a.req('/api/trivia/state');
assert.equal(s.submitted.name, name);
assert.ok(s.submitted.rank >= 1);
assert.ok(s.top.some((e) => e.you && e.name === name && e.score === expected));

// A visitor with no cookie starts over; one with a's cookie can't.
[, s] = await b.req('/api/trivia/state');
assert.equal(s.n, 0);

// Reactions from one trivia visitor reach another.
const [, start] = await b.req('/api/trivia/reactions');
assert.equal((await a.req('/api/trivia/react', { kind: 'rocket' }))[0], 200);
assert.equal((await a.req('/api/trivia/react', { kind: 'nope' }))[0], 400);
const [, got] = await b.req(`/api/trivia/reactions?after=${start.last}`);
assert.deepEqual(got.items.map((x) => x.kind), ['rocket']);

// Trivia reactions stay off the live game's stream.
const [, live] = await b.req('/api/reactions');
const [, liveAfter] = await b.req(`/api/reactions?after=${live.last}`);
assert.deepEqual(liveAfter.items, []);

console.log('trivia ok');

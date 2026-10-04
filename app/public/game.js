// Shared by the phone and host pages.
// A round: answer blind 0-20s, answer with guesses shown 20-30s.
const REVEAL_MS = 20000;
const ROUND_MS = 30000;

let clockOffset = 0;
const serverNow = () => Date.now() + clockOffset;
const syncClock = (ts) => { clockOffset = ts - Date.now(); };

function pointsAt(elapsed, max) {
  if (elapsed <= REVEAL_MS) return max;
  return Math.max(0, Math.round((max * (ROUND_MS - elapsed)) / (ROUND_MS - REVEAL_MS)));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);

function newRound(r) {
  const round = {
    n: r.n, start: r.start, q: r.q, options: r.options, points: r.points, guesses: {},
    myChoice: r.myChoice == null ? null : Number(r.myChoice),
    correct: r.correct ?? null,
    ended: !!r.ended,
  };
  for (const g of r.guesses ?? []) round.guesses[g.pid] = g;
  return round;
}

let round = null;

// Keeps `round` in sync with the server's round events.
function followRounds(es, render, onEnd, onReset) {
  const on = (type, fn) => es.addEventListener(type, (e) => {
    const d = JSON.parse(e.data);
    if (type === 'round' || type === 'reset' || round?.n === d.n) { fn(d); render(); }
  });
  on('round', (d) => { syncClock(d.serverNow); round = newRound(d); });
  on('reveal', (d) => { for (const g of d.guesses) round.guesses[g.pid] = g; });
  on('guess', (d) => { round.guesses[d.pid] = d; });
  on('end', (d) => { round.correct = d.correct; round.ended = true; onEnd(d); });
  on('reset', () => { round = null; onReset(); });
}

// 0 blind answers, 1 guesses visible, 2 over.
function phase(round) {
  const t = serverNow() - round.start;
  return t < REVEAL_MS ? 0 : t < ROUND_MS ? 1 : 2;
}

function renderOptions(box, round, onPick) {
  box.textContent = '';
  const p = phase(round);
  round.options.forEach((text, i) => {
    const b = el('button', 'opt', text);
    const who = Object.values(round.guesses).filter((g) => g.choice === i).map((g) => g.name);
    if (who.length) b.append(el('span', 'who', `${who.length}: ${who.join(', ')}`));
    if (round.myChoice === i) b.classList.add('chosen');
    if (round.ended && round.correct !== null) b.classList.add(i === round.correct ? 'right' : 'wrong');
    b.disabled = !onPick || round.myChoice !== null || round.ended || p === 2;
    if (onPick) b.onclick = () => onPick(i);
    box.append(b);
  });
}

// Updates a .timer/.bar pair for the current phase. Returns the phase.
function renderTimer(label, bar, round) {
  const t = Math.max(0, serverNow() - round.start);
  const p = phase(round);
  const until = [REVEAL_MS, ROUND_MS, ROUND_MS][p];
  const secs = `${(Math.max(0, until - t) / 1000).toFixed(1)}s`;
  bar.style.width = `${(Math.max(0, ROUND_MS - t) / ROUND_MS) * 100}%`;
  label.children[0].textContent = ['Answer now', 'Guesses are in', "Time's up"][p] + (p < 2 ? ` · ${secs}` : '');
  label.children[1].textContent = p === 2 ? '' : `${pointsAt(t, round.points)} pts`;
  return p;
}

function renderBoard(ul, top, myPid) {
  ul.textContent = '';
  for (const e of top) {
    const li = el('li');
    li.append(el('span', null, `${e.rank}. ${e.name}${e.pid === myPid ? ' (you)' : ''}`), el('span', null, e.score));
    ul.append(li);
  }
}

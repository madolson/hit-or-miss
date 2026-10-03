// Shared by the phone and host pages.
const ROUND_MS = 15000;
const FULL_MS = 5000;
const MAX_POINTS = 5000;

let clockOffset = 0;
const serverNow = () => Date.now() + clockOffset;
const syncClock = (ts) => { clockOffset = ts - Date.now(); };

function pointsAt(elapsed) {
  if (elapsed <= FULL_MS) return MAX_POINTS;
  return Math.max(0, Math.round((MAX_POINTS * (ROUND_MS - elapsed)) / (ROUND_MS - FULL_MS)));
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
    n: r.n, start: r.start, q: r.q, options: r.options, guesses: {},
    myChoice: r.myChoice == null ? null : Number(r.myChoice),
    correct: r.correct ?? null,
  };
  for (const g of r.guesses ?? []) round.guesses[g.pid] = g;
  return round;
}

let round = null;

// Keeps `round` in sync with the server's round events.
function followRounds(es, render, onEnd) {
  const on = (type, fn) => es.addEventListener(type, (e) => {
    const d = JSON.parse(e.data);
    if (type === 'round' || round?.n === d.n) { fn(d); render(); }
  });
  on('round', (d) => { syncClock(d.serverNow); round = newRound(d); });
  on('reveal', (d) => { for (const g of d.guesses) round.guesses[g.pid] = g; });
  on('guess', (d) => { round.guesses[d.pid] = d; });
  on('end', (d) => { round.correct = d.correct; onEnd(d); });
}

const timeUp = (round) => serverNow() - round.start >= ROUND_MS;

function renderOptions(box, round, onPick) {
  box.textContent = '';
  round.options.forEach((text, i) => {
    const b = el('button', 'opt', text);
    const who = Object.values(round.guesses).filter((g) => g.choice === i).map((g) => g.name);
    if (who.length) b.append(el('span', 'who', `${who.length}: ${who.join(', ')}`));
    if (round.myChoice === i) b.classList.add('chosen');
    if (round.correct !== null) b.classList.add(i === round.correct ? 'right' : 'wrong');
    b.disabled = !onPick || round.myChoice !== null || round.correct !== null || timeUp(round);
    if (onPick) b.onclick = () => onPick(i);
    box.append(b);
  });
}

// Updates a .timer/.bar pair. Returns true while the round is still open.
function renderTimer(label, bar, round) {
  const elapsed = Math.max(0, serverNow() - round.start);
  const left = Math.max(0, ROUND_MS - elapsed);
  bar.style.width = `${(left / ROUND_MS) * 100}%`;
  label.children[0].textContent = left ? `${(left / 1000).toFixed(1)}s` : "Time's up";
  label.children[1].textContent = left ? `${pointsAt(elapsed)} pts` : '';
  return left > 0;
}

function renderBoard(ul, top, myPid) {
  ul.textContent = '';
  for (const e of top) {
    const li = el('li');
    li.append(el('span', null, `${e.rank}. ${e.name}${e.pid === myPid ? ' (you)' : ''}`), el('span', null, e.score));
    ul.append(li);
  }
}

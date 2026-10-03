// Live view of the valkey:commands stream, newest first, with a rate gauge.
function watchCommands(es, box, gaugeBox) {
  const MAX_ROWS = 400;
  const WINDOW_MS = 2000;
  const gauge = createGauge(gaugeBox);
  const seen = [];
  let last = [0, 0];
  let replay = false;
  es.addEventListener('open', () => { replay = true; });
  es.addEventListener('cmds', (e) => {
    const cmds = JSON.parse(e.data);
    // The first batch after (re)connecting is history; show it but don't count it.
    const count = !replay;
    replay = false;
    for (const c of cmds) {
      // Each reconnect replays recent history; skip what's already shown.
      const id = c.id.split('-').map(Number);
      if (id[0] < last[0] || (id[0] === last[0] && id[1] <= last[1])) continue;
      last = id;
      const row = el('div');
      const t = new Date(id[0]);
      row.append(
        el('span', 's', `${t.toLocaleTimeString([], { hour12: false })}.${String(t.getMilliseconds()).padStart(3, '0')} ${c.src} `),
        el('span', 'c', c.cmd), ` ${c.args}`);
      box.prepend(row);
      if (count) seen.push(Date.now());
    }
    while (box.childElementCount > MAX_ROWS) box.lastChild.remove();
  });
  setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS;
    while (seen.length && seen[0] < cutoff) seen.shift();
    gauge(seen.length / (WINDOW_MS / 1000));
  }, 250);
}

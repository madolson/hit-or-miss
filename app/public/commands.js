// Live view of the valkey:commands stream, newest first.
function watchCommands(es, box, rateEl) {
  const MAX_ROWS = 400;
  const seen = [];
  let last = [0, 0];
  es.addEventListener('cmds', (e) => {
    const cmds = JSON.parse(e.data);
    for (const c of cmds) {
      // Each reconnect replays recent history; skip what's already shown.
      const id = c.id.split('-').map(Number);
      if (id[0] < last[0] || (id[0] === last[0] && id[1] <= last[1])) continue;
      last = id;
      const row = el('div');
      const t = new Date(Number(c.id.split('-')[0]));
      row.append(
        el('span', 's', `${t.toLocaleTimeString([], { hour12: false })}.${String(t.getMilliseconds()).padStart(3, '0')} ${c.src} `),
        el('span', 'c', c.cmd), ` ${c.args}`);
      box.prepend(row);
      seen.push(Date.now());
    }
    while (box.childElementCount > MAX_ROWS) box.lastChild.remove();
  });
  setInterval(() => {
    while (seen.length && seen[0] < Date.now() - 5000) seen.shift();
    rateEl.textContent = `${(seen.length / 5).toFixed(1)}/s`;
  }, 500);
}

// Commands-per-second gauge. Geometry and palette follow limitsGaugePinned in
// madolson/valkey-svgs (the "Valkey pinned near its limit" banner). Fixed log scale,
// base 4: one major notch per power of 4, from 1 at the start to 4096 at the stop.
function createGauge(container) {
  const NS = 'http://www.w3.org/2000/svg';
  const C = { ice: '#CCF1FF', cyan: '#00A3E0', mint: '#2CD5C4', gold: '#FFB81C', coral: '#F65275', violet: '#963CBD', ink: '#060A24' };
  const cx = 420, cy = 420, R = 330, WIDTH = 32;
  const A0 = Math.PI * 0.75, SPAN = Math.PI * 1.5; // 270 degrees, gap at the bottom
  const DECADES = 6; // 4^6 = 4096 at full scale
  const REDLINE = 5.5 / DECADES; // from 2048 up
  const at = (t) => A0 + t * SPAN;
  const pol = (rad, t) => [cx + rad * Math.cos(at(t)), cy + rad * Math.sin(at(t))];
  const arc = (rad, t0, t1) => {
    const [x0, y0] = pol(rad, t0);
    const [x1, y1] = pol(rad, t1);
    return `M ${x0} ${y0} A ${rad} ${rad} 0 ${(t1 - t0) * SPAN > Math.PI ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const node = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    parent.append(e);
    return e;
  };

  const svg = node('svg', { viewBox: '0 0 840 760', class: 'gauge' }, container);
  const defs = node('defs', {}, svg);
  for (const [id, color] of [['g-violet', C.violet], ['g-gold', C.gold]]) {
    const g = node('radialGradient', { id }, defs);
    for (const [o, op] of [[0, 0.75], [0.4, 0.22], [1, 0]]) node('stop', { offset: o, 'stop-color': color, 'stop-opacity': op }, g);
  }
  const scrim = node('radialGradient', { id: 'g-scrim' }, defs);
  for (const [o, op] of [[0, 0.72], [0.6, 0.45], [1, 0]]) node('stop', { offset: o, 'stop-color': C.ink, 'stop-opacity': op }, scrim);
  for (const s of [8, 18]) {
    const f = node('filter', { id: `g-blur${s}`, x: '-70%', y: '-70%', width: '240%', height: '240%' }, defs);
    node('feGaussianBlur', { stdDeviation: s }, f);
  }

  node('circle', { cx, cy, r: 370, fill: 'url(#g-violet)', opacity: 0.26 }, svg);
  node('path', { d: arc(R, 0, 1), fill: 'none', stroke: C.ice, 'stroke-width': WIDTH, opacity: 0.12 }, svg);
  // Ticks at 1x, 2x and 3x each power of 4, placed on the log scale, so every
  // major gap splits into three and 1, 2, 3, 4, 8, 12, 16 ... each land on a line.
  const at4 = (v) => Math.log(v) / Math.log(4) / DECADES;
  const ticks = [];
  for (let k = 0; k < DECADES; k++) for (const m of [1, 2, 3]) ticks.push(m * 4 ** k);
  ticks.push(4 ** DECADES);
  for (const v of ticks) {
    const t = at4(v);
    const major = Number.isInteger(Math.log(v) / Math.log(4));
    const [ax, ay] = pol(R - WIDTH / 2 - 8, t);
    const [bx, by] = pol(R - WIDTH / 2 - (major ? 46 : 26), t);
    node('line', { x1: ax, y1: ay, x2: bx, y2: by, stroke: t >= REDLINE ? C.coral : C.ice,
      'stroke-width': major ? 3.4 : 2, opacity: major ? 0.6 : 0.35 }, svg);
    if (major && v > 1) {
      const [lx, ly] = pol(R - WIDTH / 2 - 72, t);
      node('text', { x: lx, y: ly, class: 'gauge-tick', 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, svg)
        .textContent = v >= 1024 ? `${v / 1024}k` : v;
    }
  }

  // The fill up to the current value, drawn twice: blurred underneath for glow.
  const glow = node('g', { opacity: 0.5, filter: 'url(#g-blur18)' }, svg);
  const fill = node('g', {}, svg);
  const BANDS = [[0, 0.52, C.cyan, 0.85], [0.5, 0.8, C.mint, 0.9], [0.78, 1, C.gold, 0.95]];
  const bands = [glow, fill].flatMap((g) => BANDS.map(([, , color, op]) =>
    node('path', { fill: 'none', stroke: color, 'stroke-width': WIDTH, opacity: op }, g)));

  node('path', { d: arc(R + WIDTH / 2 + 20, REDLINE, 1), fill: 'none', stroke: C.coral, 'stroke-width': 10, opacity: 0.85 }, svg);

  // Sparks in the redline, lit only once the reading gets close to it.
  const sparks = node('g', {}, svg);
  let seed = 42041;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const [x, y] = pol(R + WIDTH / 2 + 14 + rand() * 46, REDLINE + rand() * (1 - REDLINE));
    node('circle', { cx: x, cy: y, r: 1.2 + rand() * 2.6, fill: [C.coral, C.gold, C.ice][i % 3], opacity: 0.3 + rand() * 0.55 }, sparks);
  }

  const [s0x, s0y] = pol(R - WIDTH / 2 - 30, 1);
  const [s1x, s1y] = pol(R + WIDTH / 2 + 52, 1);
  node('line', { x1: s0x, y1: s0y, x2: s1x, y2: s1y, stroke: C.coral, 'stroke-width': 13, 'stroke-linecap': 'round', opacity: 0.92 }, svg);

  const pointerGlow = node('line', { stroke: C.ice, 'stroke-width': 17, 'stroke-linecap': 'round', opacity: 0.35, filter: 'url(#g-blur8)' }, svg);
  const pointer = node('line', { stroke: C.ice, 'stroke-width': 8, 'stroke-linecap': 'round', opacity: 0.95 }, svg);

  node('circle', { cx, cy, r: 230, fill: 'url(#g-gold)', opacity: 0.45 }, svg);
  node('circle', { cx, cy, r: 126, fill: 'url(#g-scrim)' }, svg);
  const MARK_H = 224, MARK_W = MARK_H * (201.7 / 232.87);
  const markAttrs = { href: '/valkey-logo.svg', x: cx - MARK_W / 2, y: cy - MARK_H / 2, width: MARK_W, height: MARK_H, class: 'gauge-logo' };
  node('image', { ...markAttrs, opacity: 0.5, filter: 'url(#g-blur18)' }, svg);
  node('image', markAttrs, svg);

  const value = node('text', { x: cx, y: cy + 300, class: 'gauge-value', 'text-anchor': 'middle' }, svg);
  node('text', { x: cx, y: cy + 336, class: 'gauge-unit', 'text-anchor': 'middle' }, svg).textContent = 'commands/s';

  let shown = 0;
  let target = 0;
  function draw() {
    shown += (target - shown) * 0.12;
    BANDS.forEach(([t0, t1], i) => {
      const end = Math.min(t1, shown);
      const d = end > t0 ? arc(R, t0, end) : '';
      bands[i].setAttribute('d', d);
      bands[i + BANDS.length].setAttribute('d', d);
    });
    const [p0x, p0y] = pol(R - WIDTH / 2 - 68, shown);
    const [p1x, p1y] = pol(R + WIDTH / 2 + 26, shown);
    for (const l of [pointer, pointerGlow]) {
      l.setAttribute('x1', p0x); l.setAttribute('y1', p0y);
      l.setAttribute('x2', p1x); l.setAttribute('y2', p1y);
    }
    sparks.setAttribute('opacity', Math.max(0, Math.min(1, (shown - (REDLINE - 0.08)) / 0.08)));
    requestAnimationFrame(draw);
  }
  draw();

  return function update(v) {
    target = v <= 1 ? 0 : Math.min(1, at4(v));
    value.textContent = Math.round(v);
  };
}

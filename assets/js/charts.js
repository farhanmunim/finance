import { fmt, el } from './ui.js?v=60c2d4f53d';

/**
 * Accessible SVG line chart shared by the tools: hover or touch tooltip, keyboard arrows to read each
 * x value, and a screen-reader description. `width` is the width of the container in pixels.
 * series: [{ name, color, data: [{ x, y }] }] with integer x values starting at 0.
 */
export function lineChart(series, { width, title = 'Line chart of outstanding mortgage balance by year', note = ' The same balances are in the year-by-year table.', xLabel = (x) => (x === 0 ? 'Now' : `Yr ${x}`), tipLabel = (x) => (x === 0 ? 'Now' : `End of year ${x}`) } = {}) {
  const W = Math.max(320, Math.min(760, (width || 640) - 42));
  const H = Math.round(W < 480 ? W * 0.62 : W * 0.47);
  const m = { top: 16, right: 20, bottom: 36, left: 56 };
  const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
  const xMax = Math.max(1, ...series.map((s) => s.data[s.data.length - 1].x));
  const ys = series.flatMap((s) => s.data.map((p) => p.y));
  const yMaxRaw = Math.max(0, ...ys), yMinRaw = Math.min(0, ...ys);
  const step = niceCeil(Math.max(1, (yMaxRaw - yMinRaw) / 4));
  const niceY = Math.ceil(yMaxRaw / step) * step;
  const niceMin = Math.floor(yMinRaw / step) * step;
  const span = Math.max(1, niceY - niceMin);
  const ySteps = Math.round(span / step);
  const sx = (x) => m.left + (x / xMax) * iw;
  const sy = (y) => m.top + ih - ((y - niceMin) / span) * ih;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('tabindex', '0');
  const describe = (s) => { const a = s.data[0], z = s.data[s.data.length - 1]; return `${s.name}: ${fmt.gbp(a.y)} ${tipLabel(a.x).toLowerCase()} to ${fmt.gbp(z.y)} at ${tipLabel(z.x).toLowerCase()}`; };
  svg.setAttribute('aria-label', `${title}. ${series.map(describe).join('. ')}. Use the left and right arrow keys to read each year.${note}`);
  const add = (tag, attrs, parent = svg) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); parent.append(n); return n; };

  // grid + y labels
  for (let i = 0; i <= ySteps; i++) {
    const v = niceMin + (span / ySteps) * i, y = sy(v);
    add('line', { x1: m.left, x2: W - m.right, y1: y, y2: y, stroke: '#e5e7eb', 'stroke-width': 1 });
    const t = add('text', { x: m.left - 8, y: y + 4, 'text-anchor': 'end', 'font-size': 12, fill: '#6b7280' });
    t.textContent = compactGbp(v);
  }
  // x labels
  const xStep = W < 480 ? (xMax <= 6 ? 1 : xMax <= 12 ? 2 : 5) : (xMax <= 10 ? 1 : xMax <= 20 ? 2 : 5);
  for (let x = 0; x <= xMax; x += xStep) {
    const t = add('text', { x: sx(x), y: H - m.bottom + 18, 'text-anchor': 'middle', 'font-size': 12, fill: '#6b7280' });
    t.textContent = xLabel(x);
  }
  add('line', { x1: m.left, x2: W - m.right, y1: sy(0), y2: sy(0), stroke: '#9ca3af', 'stroke-width': 1 });

  for (const s of series) {
    const d = s.data.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
    add('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  }
  // hover layer
  const cross = add('line', { x1: 0, x2: 0, y1: m.top, y2: m.top + ih, stroke: '#9ca3af', 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0 });
  const dots = series.map((s) => add('circle', { r: 4.5, fill: s.color, stroke: '#fff', 'stroke-width': 2, opacity: 0 }));
  const wrap = el('div', { class: 'chart-wrap' });
  const tip = el('div', { class: 'chart-tip', 'aria-hidden': 'true' });
  const readout = el('div', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
  wrap.append(svg, tip, readout);
  let cursor = 0;
  const showAt = (x, spoken) => {
    const rect = svg.getBoundingClientRect();
    cursor = x;
    cross.setAttribute('x1', sx(x)); cross.setAttribute('x2', sx(x)); cross.setAttribute('opacity', 1);
    const lines = [`<div>${tipLabel(x)}</div>`];
    series.forEach((s, i) => {
      const p = s.data.find((q) => q.x === x);
      if (p) { dots[i].setAttribute('cx', sx(x)); dots[i].setAttribute('cy', sy(p.y)); dots[i].setAttribute('opacity', 1); lines.push(`<div><span style="color:${s.color}">●</span> ${s.name}: <b>${fmt.gbp(p.y)}</b></div>`); }
      else dots[i].setAttribute('opacity', 0);
    });
    tip.innerHTML = lines.join('');
    const px2 = (sx(x) / W) * rect.width;
    tip.style.left = `${px2}px`;
    tip.style.top = `${(m.top / H) * rect.height + 10}px`;
    tip.classList.toggle('left', px2 < rect.width * 0.25);
    tip.classList.toggle('right', px2 > rect.width * 0.75);
    tip.classList.add('show');
    if (spoken) readout.textContent = `${tipLabel(x)}. ${series.map((s) => { const p = s.data.find((q) => q.x === x); return p ? `${s.name} ${fmt.gbp(p.y)}` : null; }).filter(Boolean).join('. ')}`;
  };
  const onMove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const x = Math.round(((px - m.left) / iw) * xMax);
    if (x < 0 || x > xMax) return onLeave();
    showAt(x, false);
  };
  const onLeave = () => { cross.setAttribute('opacity', 0); dots.forEach((d) => d.setAttribute('opacity', 0)); tip.classList.remove('show'); };
  svg.addEventListener('mousemove', onMove);
  svg.addEventListener('touchmove', (e) => { onMove(e.touches[0]); }, { passive: true });
  svg.addEventListener('mouseleave', onLeave);
  svg.addEventListener('touchend', onLeave);
  svg.addEventListener('keydown', (e) => {
    const next = { ArrowRight: cursor + 1, ArrowUp: cursor + 1, ArrowLeft: cursor - 1, ArrowDown: cursor - 1, Home: 0, End: xMax }[e.key];
    if (next == null) return;
    e.preventDefault();
    showAt(Math.max(0, Math.min(xMax, next)), true);
  });
  svg.addEventListener('focus', () => showAt(cursor, false));
  svg.addEventListener('blur', onLeave);

  const legend = el('div', { class: 'legend' }, series.map((s) => el('span', { style: `--c:${s.color}`, text: s.name })));
  return el('div', {}, [wrap, legend]);
}

function niceCeil(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * p;
}
export function compactGbp(v) {
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (a >= 1e6) return `${sign}£${(a / 1e6).toFixed(a % 1e6 ? 1 : 0)}m`;
  if (a >= 1e3) return `${sign}£${Math.round(a / 1e3)}k`;
  return `${sign}£${Math.round(a)}`;
}

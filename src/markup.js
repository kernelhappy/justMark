// Markup shapes, in pixels of the uncropped capture. One SVG serves the screen overlay and the export, so they match.
// { type: 'pen'|'hl'|'line'|'arrow', c, w, pts: [[x, y], ...] }
// { type: 'rect'|'ellipse'|'cloud', c, w, fill, fc, l, t, r, b }  fill: solid in fc (missing: c)
// { type: 'poly', c, w, fill, fc, pts, open }  open: still being drawn (no fill, not closed)
// { type: 'text', c, fc, size, x, y, text, em }  em: the widest line's width per unit of size; fc: background, null = none
// { type: 'callout', c, w, size, fc, tc, x, y, text, em, tip: [x, y] }  fc: box (missing: white, null: none), tc: text (missing: #111)
export const LH = 1.25, PAD = 0.4; // line height and callout padding, in font sizes
const NO = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
const f = v => Math.round(v * 10) / 10;
// Tabs become the one space canvas measures them as; characters XML can't hold (pasted \f, NUL, U+FFFF...) are dropped, or the export won't decode.
// finishEdit stores text already clean, so its measured width matches what's drawn.
export const clean = s => s.replace(/[^\t\n\r -\uD7FF\uE000-\uFFFD\u{10000}-\u{10ffff}]/gu, '');
const esc = s => clean(s).replace(/\t/g, ' ').replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const rectD = ({ l, t, r, b }) => `M${f(l)} ${f(t)}H${f(r)}V${f(b)}H${f(l)}Z`;
const path = pts => 'M' + (pts.length > 1 ? pts : [pts[0], pts[0]]).map(([x, y]) => `${f(x)} ${f(y)}`).join('L');

// Drags the named edges ('nw', 'e', ...) of a box, kept within lim; dragging past the far edge flips.
export function dragEdges(from, edges, dx, dy, lim = NO) {
  const x = v => Math.min(lim.r, Math.max(lim.l, v)), y = v => Math.min(lim.b, Math.max(lim.t, v));
  const l = edges.includes('w') ? x(from.l + dx) : from.l, r = edges.includes('e') ? x(from.r + dx) : from.r;
  const t = edges.includes('n') ? y(from.t + dy) : from.t, b = edges.includes('s') ? y(from.b + dy) : from.b;
  return { l: Math.min(l, r), r: Math.max(l, r), t: Math.min(t, b), b: Math.max(t, b) };
}

export function bounds(s) {
  if (s.pts) {
    const xs = s.pts.map(p => p[0]), ys = s.pts.map(p => p[1]);
    const lo = a => a.reduce((m, v) => Math.min(m, v), Infinity), hi = a => a.reduce((m, v) => Math.max(m, v), -Infinity);
    return { l: lo(xs), t: lo(ys), r: hi(xs), b: hi(ys) };
  }
  if (s.size) {
    const p = s.type === 'callout' ? 2 * PAD : 0;
    return { l: s.x, t: s.y, r: s.x + s.size * (s.em + p), b: s.y + s.size * (s.text.split('\n').length * LH + p) };
  }
  return { l: s.l, t: s.t, r: s.r, b: s.b };
}

// Snaps p to the nearest multiple of 45° around p0, keeping its distance.
export function snap([x0, y0], [x, y]) {
  const d = Math.hypot(x - x0, y - y0), a = Math.round(Math.atan2(y - y0, x - x0) / (Math.PI / 4)) * Math.PI / 4;
  return [x0 + d * Math.cos(a), y0 + d * Math.sin(a)];
}

// Text sizes, in screen pixels, that the size buttons step through from any size.
const SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 80, 96];
export const nextSize = (px, dir) => (dir > 0 ? SIZES.find(v => v > px + 0.5) : SIZES.findLast(v => v < px - 0.5)) ?? px;

// WebView2's reload keys (F5, Ctrl+R) would silently wipe unsaved markup.
export const isReload = e => e.key === 'F5' || e.key === 'BrowserRefresh' || ((e.ctrlKey || e.metaKey) && (/^[a-z]$/i.test(e.key) ? e.key.toLowerCase() === 'r' : e.code === 'KeyR')); // same letter-or-physical rule as the shortcuts

// Two-point shapes drag their ends, text scales from its corners, the rest resize by edges and corners.
export const handles = s => s.pts?.length === 2 ? ['0', '1'] : s.size ? ['nw', 'ne', 'se', 'sw', ...(s.tip ? ['tip'] : [])] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function move(s, dx, dy) {
  const m = { ...s };
  if (s.pts) m.pts = s.pts.map(([x, y]) => [x + dx, y + dy]);
  if (s.tip) m.tip = [s.tip[0] + dx, s.tip[1] + dy];
  for (const k of ['l', 'r', 'x']) if (k in s) m[k] += dx;
  for (const k of ['t', 'b', 'y']) if (k in s) m[k] += dy;
  return m;
}

// h is a handle from handles(s); dx, dy is the drag so far, applied to the shape as it was when the drag started.
export function resize(s, h, dx, dy) {
  if (h === 'tip') return { ...s, tip: [s.tip[0] + dx, s.tip[1] + dy] };
  if (h === '0' || h === '1') return { ...s, pts: s.pts.map((p, i) => String(i) === h ? [p[0] + dx, p[1] + dy] : p) };
  const from = bounds(s), to = dragEdges(from, h, dx, dy);
  if (s.pts) {
    const map = (v, a0, a1, b0, b1) => a1 === a0 ? v - a0 + b0 : b0 + (v - a0) * (b1 - b0) / (a1 - a0);
    return { ...s, pts: s.pts.map(([x, y]) => [map(x, from.l, from.r, to.l, to.r), map(y, from.t, from.b, to.t, to.b)]) };
  }
  if (!s.size) return { ...s, ...to };
  // Text scales with its box, anchored at the corner opposite the handle.
  // Handles are corners, so the axis dragged further sets the scale; a drag past the anchor puts the text on its other side.
  const kx = from.r === from.l ? 1 : (to.r - to.l) / (from.r - from.l), ky = (to.b - to.t) / (from.b - from.t), k = Math.abs(kx - 1) > Math.abs(ky - 1) ? kx : ky;
  const n = { ...s, size: Math.max(4, s.size * k) }, b = bounds(n), ax = h.includes('w') ? from.r : from.l, ay = h.includes('n') ? from.b : from.t;
  return { ...n, x: to.l === ax ? ax : ax - (b.r - b.l), y: to.t === ay ? ay : ay - (b.b - b.t) };
}

// Scallops of about d along each side, bulging outward (the path runs clockwise).
function cloud({ l, t, r, b, w }, dpr) {
  const c = [[l, t], [r, t], [r, b], [l, b], [l, t]], d = Math.max(w * 5, 12 * dpr);
  let p = `M${f(l)} ${f(t)}`;
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = c[i], [x1, y1] = c[i + 1], len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.round(len / d)), rad = f(len / n / 2);
    for (let k = 1; k <= n; k++) p += `A${rad} ${rad} 0 0 1 ${f(x0 + (x1 - x0) * k / n)} ${f(y0 + (y1 - y0) * k / n)}`;
  }
  return p + 'Z';
}

// pad > 0 draws a pad-wider outline instead, for hit testing.
function draw(s, pad = 0, dpr = 1) {
  dpr = s.dpr ?? dpr; // the dpr the shape was drawn at, so zooming later doesn't change its export
  const { c } = s, w = (s.type === 'hl' ? s.w * 4 : s.w) + pad, fill = s.fill ? s.fc ?? c : 'none';
  const line = (d, more = '', fill = 'none') => `<path d="${d}" fill="${fill}" stroke="${c}" stroke-width="${f(w)}" stroke-linecap="round" stroke-linejoin="round"${more}/>`;
  const arrow = ([x0, y0], [x1, y1]) => {
    const d = Math.hypot(x1 - x0, y1 - y0), L = s.w * 3 + 12 * dpr, ux = (x1 - x0) / d || 0, uy = (y1 - y0) / d || 0, k = Math.min(L * 0.8, d);
    const bx = x1 - ux * L, by = y1 - uy * L, hw = L / 2;
    return line(`M${f(x0)} ${f(y0)}L${f(x1 - ux * k)} ${f(y1 - uy * k)}`) + `<path d="M${f(x1)} ${f(y1)}L${f(bx - uy * hw)} ${f(by + ux * hw)}L${f(bx + uy * hw)} ${f(by - ux * hw)}Z" fill="${c}"/>`;
  };
  const text = (x, y, fill) => `<text font-family="system-ui, sans-serif" font-weight="600" font-size="${f(s.size)}" fill="${fill}" dominant-baseline="central" style="white-space:pre">` +
    s.text.split('\n').map((t, i) => `<tspan x="${f(x)}" y="${f(y + s.size * (i + 0.5) * LH)}">${esc(t)}</tspan>`).join('') + '</text>';
  switch (s.type) {
    case 'pen': case 'line': return line(path(s.pts));
    case 'hl': return line(path(s.pts), ' stroke-opacity="0.4"');
    case 'arrow': return arrow(...s.pts);
    case 'rect': return line(rectD(s), '', fill);
    case 'ellipse': {
      // radii are exactly half the rounded endpoints' distance, or a large arc overshoots the box
      const [l, r, t, b] = [s.l, s.r, s.t, s.b].map(f), rx = (r - l) / 2, ry = (b - t) / 2, cy = t + ry;
      return line(`M${l} ${cy}A${rx} ${ry} 0 1 0 ${r} ${cy}A${rx} ${ry} 0 1 0 ${l} ${cy}Z`, '', fill);
    }
    case 'cloud': return line(cloud(s, dpr), '', fill);
    case 'poly': return s.open ? line(path(s.pts)) : line(path(s.pts) + 'Z', '', fill);
    case 'text': {
      if (pad) return `<path d="${rectD(bounds(s))}"/>`;
      const b = bounds(s), q = 0.15 * s.size; // a background reaches a little past the glyphs
      return (s.fc ? `<path d="${rectD({ ...b, l: b.l - q, r: b.r + q })}" fill="${s.fc}"/>` : '') + text(s.x, s.y, c);
    }
    case 'callout': {
      const b = bounds(s), p = PAD * s.size;
      return arrow([(b.l + b.r) / 2, (b.t + b.b) / 2], s.tip) + `<path d="${rectD(b)}" fill="${s.fc === undefined ? '#fff' : s.fc ?? 'none'}" stroke="${c}" stroke-width="${f(w)}"/>` + text(s.x + p, s.y + p, s.tc ?? '#111');
    }
  }
  return '';
}

// v: the part of the uncropped capture showing, { x, y, w, h }. pad > 0 adds invisible, wider copies so thin shapes are easy to click.
export const toSvg = (shapes, v, pad = 0, dpr = 1) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${v.x} ${v.y} ${v.w} ${v.h}" width="${v.w}" height="${v.h}">` +
  shapes.map((s, i) => `<g data-i="${i}">${draw(s, 0, dpr)}${pad ? `<g opacity="0">${draw(s, pad, dpr)}</g>` : ''}</g>`).join('') + '</svg>';

// The shape with new text (em: its widest line per unit of size). A callout left of or above its point keeps the edge facing
// the point, so new text grows away from it rather than over it. It stops at the image's left/top edge (or where it already
// was), or the overlay and exports clip the text. Used while typing too, so the box and tail follow the text.
export function retext(was, text, em, off) {
  const s = { ...was, text, em };
  if (!was.tip) return s;
  const a = bounds(was), b = bounds(s);
  if (a.l + a.r < 2 * was.tip[0]) s.x = Math.max(Math.min(off.x, was.x), was.x + a.r - b.r);
  if (a.t + a.b < 2 * was.tip[1]) s.y = Math.max(Math.min(off.y, was.y), was.y + a.b - b.b);
  return s;
}

// Where the text editing box sits, as % of the image, capped so it never grows past the image edge (the committed text is clipped there).
// A callout left of or above its point grows away from it while typing, as finishEdit will place it.
export function editBox(s, b, off, W, H, p) {
  const l = s.x + p - off.x, t = s.y + p - off.y, pc = v => v / W * 100 + '%', pv = v => v / H * 100 + '%';
  const e = { left: pc(l), top: pv(t), right: '', bottom: '', maxWidth: pc(W - l), maxHeight: pv(H - t) };
  if (s.tip && b.l + b.r < 2 * s.tip[0]) Object.assign(e, { left: '', right: pc(off.x + W - b.r + p), maxWidth: pc(b.r - p - off.x) });
  if (s.tip && b.t + b.b < 2 * s.tip[1]) Object.assign(e, { top: '', bottom: pv(off.y + H - b.b + p), maxHeight: pv(b.b - p - off.y) });
  return e;
}
// Scroll needed to bring a box (viewport top/bottom) clear of the fixed header (above `hi`) and bottom dock (below `lo`); the top wins.
export const clearScroll = (top, bottom, hi, lo) => top < hi ? top - hi : Math.max(0, Math.min(bottom - lo, top - hi));
// Top of a new text centered on a click, kept inside the image (above `top` it would be clipped).
export const newTextY = (y, size, top) => Math.max(top, y - size * LH / 2);

import { canvasToPdf } from './pdf.js';
import { toSvg, bounds, handles, move, resize, dragEdges, snap, nextSize, LH, PAD } from './markup.js';

const $ = id => document.getElementById(id);

// Rust hands this window its image (see main.rs); the hash is its name.
const { invoke } = window.__TAURI__.core;
const name = decodeURIComponent(location.hash.slice(1));
// png is replaced by Crop; Save, Copy and Print all use the current one, plus the markup.
// A JPEG (Open with) becomes a PNG up front: Save and Copy hand png over as-is when there's no markup.
let png = await invoke('shot').then(async buf => {
  const blob = new Blob([buf], { type: 'image/png' });
  if (new Uint32Array(buf.slice(0, 4))[0] === 0x474e5089) return blob; // \x89PNG
  const img = await createImageBitmap(blob), c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}).catch(e => { $('status').textContent = `Can't open this image: ${e.message ?? e}`; });
document.title = name;
if (png) $('shot').src = URL.createObjectURL(png);
else for (const el of document.querySelectorAll('button, input')) el.disabled = true;

// Format and quality (Save's menu) start as last picked; quality only applies to JPG and PDF. An unknown stored value leaves the default checked.
const opts = $('saveopts').elements;
const showOpts = () => { $('qfield').hidden = opts.format.value === 'png'; $('fmtlabel').textContent = opts.format.value.toUpperCase(); };
for (const n of ['format', 'quality']) if (localStorage[n]) opts[n].value = localStorage[n];
$('saveopts').onchange = ({ target }) => { localStorage[target.name] = target.value; showOpts(); };
showOpts();

// Status is a toast: Saved/Copied fade on their own, "Working…" and errors stay until replaced or clicked.
const status = $('status');
let toast;
new MutationObserver(() => {
  clearTimeout(toast);
  status.classList.remove('off');
  if (/^(Saved|Copied)/.test(status.textContent)) toast = setTimeout(() => status.classList.add('off'), 2500);
}).observe(status, { childList: true });
status.onclick = () => status.classList.add('off');

async function encode(fmt) {
  // Snapshot now: a crop or undo landing mid-encode must not pair this image with another offset (filled boxes redact).
  const png0 = png, o = off, sh = shapes.slice();
  if (fmt === 'png' && !sh.length) return png0;
  const quality = +opts.quality.value;
  const img = await createImageBitmap(png0), c = new OffscreenCanvas(img.width, img.height), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  if (sh.length) {
    const ink = new Image(), url = URL.createObjectURL(new Blob([toSvg(sh, { ...o, w: img.width, h: img.height }, 0, dpr)], { type: 'image/svg+xml' }));
    ink.src = url;
    await ink.decode().finally(() => URL.revokeObjectURL(url));
    ctx.drawImage(ink, 0, 0);
  }
  return fmt === 'png' ? c.convertToBlob({ type: 'image/png' }) : fmt === 'jpg' ? c.convertToBlob({ type: 'image/jpeg', quality }) : canvasToPdf(c, quality);
}

const ACTIONS = {
  // Encode, then Rust shows the Save dialog and writes the bytes (see save in main.rs). null: the dialog was cancelled.
  async save(fmt) {
    const file = await invoke('save', await (await encode(fmt)).arrayBuffer(), { headers: { ext: fmt } });
    return file ? 'Saved ' + file : '';
  },
  // The clipboard only takes PNG images. Handing it the promise keeps the click's activation while the markup is drawn in.
  async copy() {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': encode('png') })]);
    return 'Copied as PNG';
  },
  // Prints the encoded image, so the markup is burned in (a filled box must not leave the pixels under it in a PDF).
  // ponytail: Chrome's own menu Print can't wait for the encode and still prints the live #shot + #ink pair.
  async print() {
    const url = URL.createObjectURL(await encode('png')), p = $('printshot');
    p.src = url;
    await p.decode();
    document.body.classList.add('burned');
    // print() blocks until the dialog closes, and returns at once when blocked by policy or throttled (no afterprint),
    // so clean up on return: a lingering .burned would make a later menu Print use this stale image.
    print();
    document.body.classList.remove('burned'); p.removeAttribute('src'); URL.revokeObjectURL(url);
    return '';
  },
};

// What Save or Copy last exported: Esc closes without asking while nothing since is unsaved.
const state = () => hist[step] + JSON.stringify(off);
let saved = '[]{"x":0,"y":0}';
const closeEditor = () => (state() === saved || confirm('Close without saving or copying your markup?')) && invoke('close');

// One action at a time: a second Save would open a second dialog, and encodes are heavy. A press while one runs waits
// its turn (the latest wins), so a second Copy exports what's on screen then instead of being dropped (filled boxes redact).
let busy = false, next = null;
async function run(key) {
  const act = ACTIONS[key];
  if (!act || !png) return;
  finishEdit(); // toolbar presses keep an open text focused, so its typed text isn't in shapes yet
  if (busy) { next = key; return; }
  busy = true;
  $('status').textContent = 'Working…';
  try {
    const at = state(), msg = await act(opts.format.value);
    $('status').textContent = msg;
    if (msg) saved = at; // Save or Copy went through; a cancelled picker or Print says nothing
  } catch (e) {
    $('status').textContent = 'Failed: ' + (e.message ?? e); // Rust commands reject with a string
  } finally {
    busy = false;
  }
  if (next) { const k = next; next = null; return run(k); }
}
document.onclick = ({ target }) => run(target.dataset.act);

// Zoom: 'fit' (whole capture), 'width', or a factor where 1 = actual size (one capture pixel per screen pixel).
// The fit modes never enlarge past actual size.
const shot = $('shot'), header = document.querySelector('header');
// The header is fixed, not sticky, so it stays put when a zoomed-in capture scrolls sideways; pad the page by its height.
new ResizeObserver(() => { document.body.style.paddingTop = header.offsetHeight + 'px'; applyZoom(); }).observe(header); // status text or the Quality select can wrap it
let zoom = 'fit', scale = 1;
function applyZoom() {
  const w = shot.naturalWidth / devicePixelRatio, h = shot.naturalHeight / devicePixelRatio;
  if (!w) return;
  const cw = document.documentElement.clientWidth, fitW = Math.min(1, (cw - 32) / w);
  // A window smaller than the chrome would give a zero or negative fit; floor it at the zoom-out limit.
  scale = Math.max(0.05, zoom === 'fit' ? Math.min(fitW, (innerHeight - header.offsetHeight - 104) / h) : zoom === 'width' ? fitW : zoom);
  shot.style.width = w * scale + 'px';
  document.body.style.setProperty('--actual', w + 'px'); // print at Actual size, not one CSS px per image pixel
  // Fit can drop the old layout's vertical scrollbar, which fires no resize: measure again without it (only on widening, so it can't loop).
  if (zoom === 'fit' && document.documentElement.clientWidth > cw) return applyZoom();
  $('zoom').textContent = Math.round(scale * 100) + '%';
  render();
}
// While a crop or Undo crop swaps the image, gestures wait: until it loads, the old image's geometry would meet the new offset.
let swapping = false, shown = false;
// The window starts hidden; Rust sizes it to what the page asks for (capped to the screen) and shows it.
// The capture goes in image px, not over devicePixelRatio: that is the scale where the hidden window was made, maybe not
// the monitor it opens on. Chrome and minimum are CSS px, which Rust scales for that monitor.
// 960 wide keeps the top bar on one row and the style dock clear of the zoom pill; 104/120 is the room the dock takes below.
const show = (w, h) => shown || (shown = true, invoke('ready', { img: [w, h], chrome: [48, header.offsetHeight + 120], min: [960, 480] }));
shot.onload = () => {
  swapping = false;
  applyZoom();
  show(shot.naturalWidth, shot.naturalHeight); // the capture at actual size, plus the chrome
};
shot.onerror = () => { $('status').textContent ||= "Can't open this image."; show(0, 0); };
if (!png) show(0, 0);
onresize = () => { syncDpr(); applyZoom(); };
// A move to a monitor with another scale factor can keep the CSS size and fire no resize; a resolution query still flips.
const watchDpr = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { onresize(); watchDpr(); }, { once: true });
watchDpr();
const zoomBy = f => { zoom = Math.min(8, Math.max(0.05, scale * f)); applyZoom(); };
$('zoombar').onclick = ({ target }) => {
  const z = target.dataset.zoom;
  if (!z) return;
  if (z === 'in' || z === 'out') return zoomBy(z === 'in' ? 1.25 : 0.8);
  zoom = z;
  applyZoom();
};
// Ctrl+wheel (and trackpad pinch) zooms the capture instead of the page, keeping the point under the pointer in place.
addEventListener('wheel', e => {
  if (!e.ctrlKey || !shot.naturalWidth) return;
  e.preventDefault();
  const r = shot.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  zoomBy(Math.exp(-e.deltaY * 0.002));
  const n = shot.getBoundingClientRect();
  scrollBy(n.left + fx * n.width - e.clientX, n.top + fy * n.height - e.clientY);
}, { passive: false });

const stage = $('stage'), sel = $('sel'), pickBox = $('pick'), edit = $('edit'), ink = $('ink');
const cropping = () => stage.classList.contains('cropping');
// Pointer position in pixels of the current image; the rect is re-read on every move so scrolling mid-drag still lines up.
const at = ev => { const r = shot.getBoundingClientRect(), f = shot.naturalWidth / r.width; return [(ev.clientX - r.left) * f, (ev.clientY - r.top) * f]; };
// Percentages keep boxes in place when the zoom changes. o: where the current image starts in b's coordinates.
function place(el, b, o = { x: 0, y: 0 }) {
  const W = shot.naturalWidth, H = shot.naturalHeight;
  Object.assign(el.style, { left: (b.l - o.x) / W * 100 + '%', top: (b.t - o.y) / H * 100 + '%', width: (b.r - b.l) / W * 100 + '%', height: (b.b - b.t) / H * 100 + '%' });
}

// Crop: Crop starts a selection. Drag to draw a box, then drag its handles to resize it or its inside to move it.
// Enter or Apply crop keeps it, Esc cancels. Undo crop goes back to the full capture.
let original, box; // box edges in capture pixels: { l, t, r, b }
const clamp = (v, max) => Math.min(max, Math.max(0, v));
function setShot(blob) {
  swapping = true;
  png = blob;
  URL.revokeObjectURL(shot.src);
  shot.src = URL.createObjectURL(blob);
  $('uncrop').hidden = !original;
}
function endCrop() {
  stage.classList.remove('cropping');
  sel.hidden = true;
  box = null;
  $('crop').setAttribute('aria-pressed', false);
}
// Leaves crop mode before the first await, so a repeat click or Enter can't apply twice and Esc has nothing left to cancel;
// the new image and its offset are taken from one snapshot and set together.
async function applyCrop() {
  const b = box, src = png, o = off;
  endCrop();
  if (!b) return;
  const x = Math.floor(b.l), y = Math.floor(b.t), w = Math.round(b.r) - x, h = Math.round(b.b) - y;
  if (w <= 0 || h <= 0) return;
  swapping = true;
  try {
    const img = await createImageBitmap(src, x, y, w, h), c = new OffscreenCanvas(w, h);
    c.getContext('2d').drawImage(img, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    if (png !== src) return; // Undo crop landed meanwhile; applying now would make original a cropped image
    original ??= src;
    off = { x: o.x + x, y: o.y + y, w, h }; // w, h: only so state() sees a crop that keeps the top-left corner
    setShot(blob);
  } finally {
    if (png === src) swapping = false; // failed: no new image is coming
  }
}
// The style dock turns into the crop bar (hint, Cancel, Apply) while cropping; see index.html.
$('crop').onclick = () => {
  if (cropping()) return applyCrop();
  finishEdit();
  cur = null;
  render();
  stage.classList.add('cropping');
  $('crop').setAttribute('aria-pressed', true);
};
$('cropapply').onclick = applyCrop;
$('cropcancel').onclick = endCrop;
$('uncrop').onclick = () => { if (cropping()) endCrop(); const o = original; original = null; off = { x: 0, y: 0 }; setShot(o); };
function cropDown(e) {
  const W = shot.naturalWidth, H = shot.naturalHeight, [x0, y0] = at(e);
  // A handle drags its edges ('nw', 'e', ...), the box's inside moves it, anywhere else draws a new box from its 'se' corner.
  const fresh = !e.target.dataset.h && e.target !== sel, edges = fresh ? 'se' : e.target.dataset.h;
  const from = fresh ? { l: clamp(x0, W), t: clamp(y0, H), r: clamp(x0, W), b: clamp(y0, H) } : { ...box };
  stage.onpointermove = ev => {
    const [x, y] = at(ev), dx = x - x0, dy = y - y0;
    if (!edges) {
      const mx = Math.min(W - from.r, Math.max(-from.l, dx)), my = Math.min(H - from.b, Math.max(-from.t, dy));
      box = { l: from.l + mx, t: from.t + my, r: from.r + mx, b: from.b + my };
    } else box = dragEdges(from, edges, dx, dy, { l: 0, t: 0, r: W, b: H });
    place(sel, box);
    sel.hidden = false;
  };
  stage.onpointerup = () => { stage.onpointermove = null; };
}

// Markup: shapes live in pixels of the uncropped capture (see markup.js); off is where the current image starts in them.
// Widths and text sizes are picked in screen pixels and stored in capture pixels.
let dpr = devicePixelRatio;
// Browser zoom or another monitor changes devicePixelRatio; keep the picked width and text size the same on screen.
// Picks are whole screen pixels, so rounding keeps d.w * dpr === style.w exact for the pressed state.
function syncDpr() {
  if (devicePixelRatio === dpr) return;
  for (const s of [style.pen, style.hl]) for (const k of ['w', 'size']) if (k in s) s[k] = Math.round(s[k] / dpr) * devicePixelRatio;
  dpr = devicePixelRatio;
}
// What the style dock offers per shape type or tool (see render).
const KINDS = { select: '', hl: 'c w', pen: 'c w', line: 'c w', arrow: 'c w', rect: 'c w f', ellipse: 'c w f', cloud: 'c w f', text: 'c s', callout: 'c w s' };
let shapes = [], hist = ['[]'], step = 0, off = { x: 0, y: 0 }, tool = 'select', cur = null, editing = null, lastDown = 0, gesture = false;
const style = { pen: { c: '#e53935', w: 4 * dpr, size: 20 * dpr, fill: false }, hl: { c: '#fdd835', w: 4 * dpr } };
const styleOf = type => type === 'hl' ? style.hl : style.pen;
// Lines, pens and text have no fill, so Fill shows and toggles the default with one of them selected.
const filled = s => s && 'fill' in s ? s.fill : style.pen.fill;
const measure = new OffscreenCanvas(1, 1).getContext('2d');
measure.font = '600 100px system-ui, sans-serif';

function render() {
  const W = shot.naturalWidth;
  if (!W) return;
  ink.innerHTML = toSvg(shapes, { ...off, w: W, h: shot.naturalHeight }, 12 * W / shot.clientWidth, dpr);
  const s = shapes[cur];
  pickBox.hidden = !s || editing != null;
  if (!pickBox.hidden) {
    const b = bounds(s), hs = handles(s), pts = { 0: s.pts?.[0], 1: s.pts?.[1], tip: s.tip };
    place(pickBox, b, off);
    pickBox.classList.toggle('ends', hs[0] === '0');
    for (const i of pickBox.children) {
      const h = i.dataset.h, p = pts[h];
      i.hidden = !hs.includes(h);
      if (p) Object.assign(i.style, { left: `calc(${(p[0] - b.l) / (b.r - b.l || 1) * 100}% - 6px)`, top: `calc(${(p[1] - b.t) / (b.b - b.t || 1) * 100}% - 6px)` });
    }
  }
  if (editing != null) {
    const s = shapes[editing], k = shot.clientWidth / W, p = s.tip ? PAD * s.size : 0;
    ink.querySelector(`[data-i="${editing}"]`).style.visibility = 'hidden';
    Object.assign(edit.style, { left: (s.x + p - off.x) / W * 100 + '%', top: (s.y + p - off.y) / shot.naturalHeight * 100 + '%', font: `600 ${s.size * k}px/${LH} system-ui, sans-serif`, color: s.tip ? '#111' : s.c, background: s.tip || !['#ffffff', '#fdd835'].includes(s.c) ? '' : '#000c' });
  }
  const now = s ?? styleOf(tool);
  for (const b of document.querySelectorAll('[data-tool], [data-c], [data-w], [data-fill], [data-cmd]')) {
    const d = b.dataset;
    if (d.cmd) b.disabled = d.cmd === 'undo' ? !step : d.cmd === 'redo' ? step === hist.length - 1 : !s;
    else b.setAttribute('aria-pressed', d.tool ? d.tool === tool : d.c ? d.c === now.c : d.w ? d.w * dpr === now.w : filled(s));
  }
  // The dock shows only what applies to the selected shape, else to the tool: c(olor) w(idth) f(ill) s(ize) d(elete). Empty hides it.
  $('props').dataset.k = (KINDS[s?.type ?? tool] + (s ? ' d' : '')).trim();
  $('tsize').textContent = Math.round((s?.size ?? style.pen.size) / dpr);
}
function commit() {
  const j = JSON.stringify(shapes);
  if (j !== hist[step]) {
    hist.length = ++step;
    hist.push(j);
  }
  render();
}
function go(d) {
  if (!hist[step + d]) return;
  step += d;
  shapes = JSON.parse(hist[step]);
  cur = null;
  render();
}
function remove() {
  if (cur == null) return;
  shapes.splice(cur, 1);
  cur = null;
  commit();
}
// No browser menu (Back, Reload, Save as…); the text editor keeps its cut/copy/paste menu.
oncontextmenu = e => e.target === edit || e.preventDefault();
// A press must not blur an open text editor: finishEdit would delete an empty new text before the click lands.
$('tools').onmousedown = $('props').onmousedown = e => e.preventDefault();
$('tools').onclick = $('props').onclick = ({ target }) => {
  if (gesture) return;
  const d = target.closest('button')?.dataset ?? {}, s = shapes[cur];
  // Tool, Undo, Redo and Delete end an open edit first; on an empty new text that just cancels it, so Undo doesn't also undo the last commit.
  if (editing != null && (d.tool || d.cmd)) {
    const empty = !edit.value.trimEnd();
    finishEdit();
    if (empty && d.cmd) return render();
  }
  if (d.tool) {
    if (cropping()) endCrop();
    tool = stage.dataset.tool = d.tool;
    cur = null;
  } else if (d.cmd) ({ undo: () => go(-1), redo: () => go(1), del: remove })[d.cmd]();
  else {
    // A style button sets the style for new shapes of that kind and restyles the selected shape.
    // Text size and fill only apply to some shapes, so they always come from and go to the main style.
    const k = d.c ? 'c' : d.w ? 'w' : d.size ? 'size' : 'fill' in d ? 'fill' : null;
    if (!k) return;
    const v = k === 'c' ? d.c : k === 'w' ? d.w * dpr : k === 'size' ? nextSize((s?.size ?? style.pen.size) / dpr, +d.size) * dpr : !filled(s);
    (k === 'size' || k === 'fill' ? style.pen : styleOf(s?.type ?? tool))[k] = v;
    if (s && k in s) {
      shapes[cur] = { ...s, [k]: v };
      return editing == null ? commit() : render(); // an open edit commits its style with its text
    }
  }
  render();
};

function startEdit(i) {
  editing = cur = i;
  edit.value = shapes[i].text;
  edit.hidden = false;
  render();
  edit.focus();
  // focus() won't scroll an editor that is in the viewport but under the fixed header.
  const under = header.offsetHeight - edit.getBoundingClientRect().top;
  if (under > 0) scrollBy(0, -under);
}
// Click away or Esc keeps the text; emptied text removes its shape.
function finishEdit() {
  if (editing == null) return;
  const i = editing, text = edit.value.trimEnd();
  editing = null;
  edit.hidden = true;
  const was = shapes[i];
  if (text) shapes[i] = { ...shapes[i], text, em: text.split('\n').reduce((m, l) => Math.max(m, measure.measureText(l).width), 0) / 100 };
  if (text && was.tip) {
    // A callout left of or above its point keeps the edge facing the point, so new text grows away from it rather than over it.
    const a = bounds(was), b = bounds(shapes[i]);
    if (a.l + a.r < 2 * was.tip[0]) shapes[i].x += a.r - b.r;
    if (a.t + a.b < 2 * was.tip[1]) shapes[i].y += a.b - b.b;
  } else if (!text) {
    shapes.splice(i, 1);
    cur = null;
  }
  commit();
}
// A window blur (Alt+Tab) keeps the textarea focused for when the window returns; only a real blur ends the edit.
edit.onblur = () => document.activeElement === edit || finishEdit();
// Menu Print's dialog is that kind of blur too, so finish before it lays out the page.
addEventListener('beforeprint', finishEdit);

function newShape(p) {
  const { c, w, size } = styleOf(tool);
  if (tool === 'pen' || tool === 'hl') return { type: tool, c, w, pts: [p] };
  if (tool === 'line') return { type: tool, c, w, pts: [p, p] };
  // dpr: arrowheads, callout pointers and cloud scallops keep the minimum size they had when drawn
  if (tool === 'arrow') return { type: tool, c, w, dpr, pts: [p, p] };
  if (tool === 'callout') return { type: tool, c, w, dpr, size, x: p[0], y: p[1], text: '', em: 0, tip: p };
  return { type: tool, c, w, dpr, fill: style.pen.fill, l: p[0], t: p[1], r: p[0], b: p[1] };
}
const atInk = ev => { const [x, y] = at(ev); return [x + off.x, y + off.y]; };
// A handle of the selected shape resizes it; otherwise Select picks and moves, Text places or edits on release, and the rest draw.
function markDown(e) {
  const p0 = atInk(e), h = e.target.closest('#pick') && e.target.dataset.h, hit = e.target.closest('#ink [data-i]'), hi = hit && +hit.dataset.i;
  const k = shot.naturalWidth / shot.clientWidth; // capture px per screen px, so drag thresholds don't change with zoom
  let i = cur, upd;
  if (h) {
    const from = shapes[i];
    upd = (ev, dx, dy) => {
      const r = resize(from, h, dx, dy);
      if (ev.shiftKey && r.pts?.length === 2) r.pts[h] = snap(r.pts[1 - h], r.pts[h]); // Shift snaps an end to 45° steps
      return r;
    };
  } else if (tool === 'select') {
    // Double-click is detected here: the re-render below replaces the pressed element, so Chrome sends no dblclick.
    const again = hit && hi === cur && e.timeStamp - lastDown < 500;
    lastDown = e.timeStamp;
    cur = hit ? hi : null;
    render();
    if (!hit) return;
    if (again && shapes[hi].size) {
      stage.onpointermove = null;
      stage.onpointerup = () => { stage.onpointerup = null; startEdit(hi); };
      return;
    }
    const from = shapes[i = cur];
    upd = (ev, dx, dy) => move(from, dx, dy);
  } else if (tool === 'text') {
    stage.onpointermove = null;
    // On release, so the press's own focus handling can't blur the new editor.
    stage.onpointerup = () => {
      stage.onpointerup = null;
      if (hit && shapes[hi].size) return startEdit(hi);
      const { c, size } = styleOf(tool);
      startEdit(shapes.push({ type: 'text', c, size, x: p0[0], y: p0[1] - size * LH / 2, text: '', em: 0 }) - 1);
    };
    return;
  } else {
    cur = null;
    i = shapes.push(newShape(p0)) - 1;
    const from = shapes[i];
    upd = tool === 'pen' || tool === 'hl' ? (ev, dx, dy, p) => {
      const s = shapes[i], q = s.pts.at(-1);
      if (ev.shiftKey) s.pts = [p0, snap(p0, p)];
      else if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= 2 * k) s.pts.push(p);
      return s;
    } : tool === 'line' || tool === 'arrow' ? (ev, dx, dy, p) => ({ ...from, pts: [p0, ev.shiftKey ? snap(p0, p) : p] })
      : tool === 'callout' ? (ev, dx, dy, p) => ({ ...from, x: p[0], y: p[1] })
      : (ev, dx, dy) => {
        if (ev.shiftKey) {
          const m = Math.max(Math.abs(dx), Math.abs(dy));
          dx = Math.sign(dx) * m || m;
          dy = Math.sign(dy) * m || m;
        }
        return { ...from, l: Math.min(p0[0], p0[0] + dx), r: Math.max(p0[0], p0[0] + dx), t: Math.min(p0[1], p0[1] + dy), b: Math.max(p0[1], p0[1] + dy) };
      };
  }
  stage.onpointermove = ev => {
    const p = atInk(ev);
    shapes[i] = upd(ev, p[0] - p0[0], p[1] - p0[1], p);
    render();
  };
  stage.onpointerup = () => {
    stage.onpointermove = stage.onpointerup = null;
    if (h || tool === 'select') return commit();
    const b = bounds(shapes[i]);
    if (!['pen', 'hl', 'callout'].includes(tool) && b.r - b.l < 3 * k && b.b - b.t < 3 * k) {
      shapes.splice(i, 1); // a click, not a drag
      return render();
    }
    cur = i;
    if (tool === 'callout') startEdit(i);
    else commit();
  };
}

// One gesture at a time: while a drag holds the pointer, other pointers and the editing keys wait, since its handlers hold a fixed shape index.
// Losing the capture (release, pointercancel) ends the gesture as a release would, so hover can't keep drawing.
stage.onpointerdown = e => {
  if (gesture || swapping || e.button || e.target === edit) return;
  if (editing != null) return finishEdit();
  e.preventDefault(); // which also keeps focus where it was, so drop it from the toolbar: a focus ring there looks like the active tool
  document.activeElement.blur();
  stage.setPointerCapture(e.pointerId);
  gesture = true;
  (cropping() ? cropDown : markDown)(e);
};
stage.onpointercancel = stage.onlostpointercapture = e => {
  stage.onpointerup?.(e);
  stage.onpointermove = stage.onpointerup = null;
  gesture = false;
};
onkeydown = e => {
  // Shortcuts follow the letter on Latin layouts (Dvorak too) and the physical key on others, like Chrome's print.
  const k = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : /^Key[A-Z]$/.test(e.code) ? e.code[3].toLowerCase() : e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'p') {
    e.preventDefault();
    finishEdit();
    return e.repeat || run('print');
  }
  if (gesture) return;
  if (cropping()) {
    if (e.key === 'Escape') endCrop();
    if (e.key === 'Enter') { e.preventDefault(); applyCrop(); }
    return;
  }
  if (e.target === edit) {
    if (e.key === 'Escape' && !e.isComposing) finishEdit();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
    e.preventDefault();
    go(k === 'y' || e.shiftKey ? 1 : -1);
  } else if ((e.ctrlKey || e.metaKey) && (k === 's' || k === 'c')) {
    e.preventDefault();
    if (!e.repeat) run(k === 's' ? 'save' : 'copy'); // a held Ctrl+S would queue a second Save dialog
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && e.target.tagName !== 'INPUT') remove();
  else if (e.key === 'Escape') {
    if (document.querySelector(':popover-open')) return; // the Save menu closes itself
    // Esc steps back to Select, then closes the editor (the snip is already on the clipboard).
    if (tool === 'select' && cur == null) return closeEditor();
    cur = null;
    tool = stage.dataset.tool = 'select';
    render();
  } else if (/^[a-z]$/.test(k) && !e.ctrlKey && !e.metaKey && !e.altKey && e.target.tagName !== 'INPUT') {
    // Single-letter tool keys: the button's data-key (shown in its tooltip) is the binding.
    document.querySelector(`[data-key="${k.toUpperCase()}"]`)?.click();
  }
};


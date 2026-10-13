import { canvasToPdf, toDib } from './pdf.js';
import { toSvg, pattern, bounds, handles, move, resize, dragEdges, snap, nextSize, clean, isReload, editBox, LH, PAD, clearScroll, newTextY, retext } from './markup.js';

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
  // JPG and PDF (JPEG pages) have no alpha: flatten a transparent PNG onto white, or its clear areas encode as black.
  if (fmt !== 'png') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, img.width, img.height); }
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
  // Auto copy runs after the window lost focus, where navigator.clipboard refuses: Rust writes the same PNG, plus a DIB.
  async autocopy() {
    const png = await encode('png'), img = await createImageBitmap(png), c = new OffscreenCanvas(img.width, img.height), ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const a = new Uint8Array(await png.arrayBuffer()), b = toDib(ctx.getImageData(0, 0, img.width, img.height).data, img.width, img.height);
    const body = new Uint8Array(a.length + b.length);
    body.set(a);
    body.set(b, a.length);
    // false: something newer was copied meanwhile, so this stays unsaved (Esc still asks).
    return await invoke('clip', body, { headers: { png: String(a.length) } }) ? 'Copied as PNG' : '';
  },
  // Prints the encoded image, so the markup is burned in (a filled box must not leave the pixels under it in a PDF).
  // ponytail: Chrome's own menu Print can't wait for the encode and still prints the live #shot + #ink pair.
  async print() {
    const url = URL.createObjectURL(await encode('png')), p = $('printshot');
    p.src = url;
    await p.decode();
    // Size from this image, not body's --actual: a crop can swap #shot (and --actual) while the encode runs.
    p.style.setProperty('--actual', p.naturalWidth / devicePixelRatio + 'px');
    document.body.classList.add('burned');
    // print() blocks until the dialog closes, and returns at once when blocked by policy or throttled (no afterprint),
    // so clean up on return: a lingering .burned would make a later menu Print use this stale image.
    print();
    document.body.classList.remove('burned'); p.removeAttribute('src'); URL.revokeObjectURL(url);
    return '';
  },
};

// What Save or Copy last exported: Esc closes without asking while nothing since is unsaved. The history has the crop too.
const state = () => hist[step];
let saved = '[[],null]';
// What a Save or Copy the user pressed last exported. Rust is told about unsaved work against this, not `saved`: an
// editor with unsaved work doesn't take the next snip, and Max windows closes others first. An Auto copy fires
// whenever focus leaves (a new snip too), so it lets Esc close without asking but doesn't make the window disposable.
// A text being typed or a stroke being drawn isn't in the history yet but counts.
let kept = saved, reported = false;
const report = () => { const d = editing != null || gesture || poly != null || state() !== kept; if (d !== reported) invoke('dirty', { d: reported = d }); };
// While set, focus loss is our own dialog's (or the window closing), not the user leaving: no Auto copy.
let modal = false;
const closeEditor = () => {
  modal = true;
  if (state() === saved || confirm('Close without saving or copying your markup?')) return invoke('close');
  modal = false;
};
// Auto copy (a setting): leaving the window with unsaved markup copies it, as Copy would, so Esc won't ask (see `kept`).
// Save and Print dialogs hold `busy`; a pending crop isn't markup yet.
onblur = async () => {
  if (modal || busy || !png || cropping() || (editing == null && state() === saved)) return;
  if ((await invoke('settings'))[0].autoCopy) run('autocopy');
};

// One action at a time: a second Save would open a second dialog, and encodes are heavy. A Copy pressed while one runs
// waits its turn, so it exports what's on screen then instead of being dropped (filled boxes redact). Save/Print presses
// while busy are dropped: a double-click on Save must not queue a second dialog.
let busy = false, next = null;
async function run(key) {
  const act = ACTIONS[key];
  if (!act || !png) return;
  // The pending crop box isn't in png yet: exporting now would ship the area being cut away (Ctrl+P lands here too).
  if (cropping()) { $('status').textContent = 'Apply or cancel the crop first'; return; }
  finishEdit(); // toolbar presses keep an open text focused, so its typed text isn't in shapes yet
  endPoly(); // a polygon being drawn goes in as it stands
  if (busy) { if (key === 'copy') next = key; return; }
  busy = true;
  $('status').textContent = 'Working…';
  try {
    const at = state(), msg = await act(opts.format.value);
    $('status').textContent = msg;
    if (msg) { saved = at; if (key !== 'autocopy') kept = at; } // Save or Copy went through; a cancelled picker or Print says nothing
    report();
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
// Height only: its width follows the page's vertical scrollbar, which Fit width can toggle, and re-fitting on that would flip forever.
let headH; new ResizeObserver(() => { if (header.offsetHeight === headH) return; document.body.style.paddingTop = (headH = header.offsetHeight) + 'px'; applyZoom(); }).observe(header); // status text or the Quality select can wrap it
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
  // Fit width can add a vertical scrollbar: measure again with it so the capture doesn't overflow (only on narrowing, so it can't loop).
  if (zoom === 'width' && document.documentElement.clientWidth < cw) return applyZoom();
  $('zoom').textContent = Math.round(scale * 100) + '%';
  render();
}
// While a crop, Crop again or an undo swaps the image, gestures wait: until it loads, the old image's geometry would meet the new offset.
let swapping = false, shown = false;
// The window starts hidden; Rust sizes it to what the page asks for (capped to the screen) and shows it.
// The capture goes in image px, not over devicePixelRatio: that is the scale where the hidden window was made, maybe not
// the monitor it opens on. Chrome and minimum are CSS px, which Rust scales for that monitor.
// 960 wide keeps the top bar on one row and the style dock clear of the zoom pill; 104/120 is the room the dock takes below.
const show = (w, h) => shown || (shown = true, onerror = onunhandledrejection = null, invoke('ready', { img: [w, h], chrome: [48, header.offsetHeight + 120], min: [960, 480] }));
shot.onload = () => {
  swapping = false;
  full ??= [shot.naturalWidth, shot.naturalHeight]; // the first image is the original
  applyZoom();
  if (cropping() && box) { place(sel, box); sel.hidden = false; } // Crop again: the current crop over the whole original
  show(shot.naturalWidth, shot.naturalHeight); // the capture at actual size, plus the chrome
};
// A PNG that passed the magic check but won't decode: disable everything as for a failed load, or Save writes the broken bytes.
shot.onerror = () => { swapping = false; $('status').textContent ||= "Can't open this image."; png = null; for (const el of document.querySelectorAll('button, input')) el.disabled = true; show(0, 0); };
if (!png) show(0, 0);
onresize = () => { dpr = devicePixelRatio; applyZoom(); };
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

// Crop: a view of the original capture, never destructive. Crop shows the whole original with the current crop as the box;
// drag to draw a box, drag its handles to resize it or its inside to move it. Enter or Apply keeps it (one undo step),
// Esc or Cancel goes back, Reset makes the box the whole capture.
// crop: { x, y, w, h } in capture pixels, or null; it is in the history with the shapes. crops: each crop's image, by JSON.
let box, full, crop = null, cutting = false; // box edges in capture pixels: { l, t, r, b }; full: the original's [w, h]
const original = png, crops = new Map([['null', png]]);
const clamp = (v, max) => Math.min(max, Math.max(0, v));
// The image showing and where it starts in capture pixels, set together: an export pairs them (see encode).
function setShot(blob, o) {
  swapping = true;
  png = blob;
  off = o;
  URL.revokeObjectURL(shot.src);
  shot.src = URL.createObjectURL(blob);
}
// Back to the current crop's image, unless it is showing.
function showCrop() {
  const b = crops.get(JSON.stringify(crop));
  if (b !== png) setShot(b, crop ? { x: crop.x, y: crop.y } : { x: 0, y: 0 });
}
function endCrop() {
  stage.classList.remove('cropping');
  sel.hidden = true;
  box = null;
  $('crop').setAttribute('aria-pressed', false);
  showCrop();
}
// Leaves crop mode before the first await, so a repeat click or Enter can't apply twice and Esc has nothing left to cancel.
// The box is in the original's pixels (crop mode shows it whole).
async function applyCrop() {
  const b = box;
  endCrop();
  if (!b) return;
  const x = Math.floor(b.l), y = Math.floor(b.t), w = Math.round(b.r) - x, h = Math.round(b.b) - y;
  if (w <= 0 || h <= 0) return;
  const next = x || y || w !== full[0] || h !== full[1] ? { x, y, w, h } : null, key = JSON.stringify(next);
  if (key === JSON.stringify(crop)) return;
  if (!crops.has(key)) {
    cutting = true; // gestures wait: the offset changes when this lands
    try {
      const img = await createImageBitmap(original, x, y, w, h), c = new OffscreenCanvas(w, h);
      c.getContext('2d').drawImage(img, 0, 0);
      crops.set(key, await c.convertToBlob({ type: 'image/png' })); // ponytail: every crop's PNG is kept for undo; fine for a handful
    } catch (e) {
      $('status').textContent = 'Crop failed: ' + (e.message ?? e);
      return;
    } finally {
      cutting = false;
    }
    if (cropping()) return; // Crop was pressed again meanwhile: it shows the original, with the old crop's box
  }
  crop = next;
  commit();
  showCrop();
}
// The style dock turns into the crop bar (hint, Reset, Cancel, Apply) while cropping; see index.html.
$('crop').onclick = () => {
  if (cropping()) return applyCrop();
  finishEdit();
  endPoly();
  cur = null;
  render();
  stage.classList.add('cropping');
  $('crop').setAttribute('aria-pressed', true);
  if (!crop) return;
  box = { l: crop.x, t: crop.y, r: crop.x + crop.w, b: crop.y + crop.h };
  setShot(original, { x: 0, y: 0 }); // the box is placed once it has loaded (see shot.onload)
};
$('cropapply').onclick = applyCrop;
$('cropcancel').onclick = endCrop;
$('cropreset').onclick = () => { box = { l: 0, t: 0, r: full[0], b: full[1] }; place(sel, box); sel.hidden = false; };
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
// Widths and text sizes are picked in screen pixels and stored in capture pixels: times dpr, which follows browser zoom and the monitor.
let dpr = devicePixelRatio;
// What the style dock offers per shape type or tool (see render).
const KINDS = { select: '', hl: 'c w', pen: 'c w o', line: 'c w o', arrow: 'c w o', rect: 'c w f o', ellipse: 'c w f o', cloud: 'c w f o', poly: 'c w f o', text: 'c s', callout: 'c w s' };
let shapes = [], hist = ['[[],null]'], step = 0, off = { x: 0, y: 0 }, tool = 'select', cur = null, editing = null, lastDown = 0, gesture = false;
// Each tool's style, in screen pixels, for its next shape. Kept in localStorage (shared by every editor window, like Save's
// format), one key per tool so two windows restyling different tools don't overwrite each other.
const RED = '#e53935', STYLES = {
  // see: see-through (covers nothing), at opacity op.
  hl: { c: '#fdd835', w: 4 }, pen: { c: RED, w: 4, see: false, op: 0.4 }, line: { c: RED, w: 4, see: false, op: 0.4 }, arrow: { c: RED, w: 4, see: false, op: 0.4 },
  // fill: false or what it is (see FILLS); last: what Fill's button turns on; dn: pattern density.
  rect: { c: RED, w: 4, fill: false, last: 'solid', dn: 1, see: false, op: 0.4 }, ellipse: { c: RED, w: 4, fill: false, last: 'solid', dn: 1, see: false, op: 0.4 },
  cloud: { c: RED, w: 4, fill: false, last: 'solid', dn: 1, see: false, op: 0.4 }, poly: { c: RED, w: 4, fill: false, last: 'solid', dn: 1, see: false, op: 0.4 },
  text: { c: RED, size: 20, fc: null }, callout: { c: RED, w: 4, size: 20, fc: '#fff', tc: '#111' },
};
function styleOf(t) {
  let s;
  try { s = JSON.parse(localStorage['style.' + t]); } catch {} // none stored yet, or storage unavailable
  return { ...STYLES[t], ...s };
}
function setStyle(t, ch) {
  try { localStorage['style.' + t] = JSON.stringify({ ...styleOf(t), ...ch }); } catch {}
}
// Color targets: the style key each of the picker's Line · Fill · Text sets, per shape type. The rest only have a line color.
// fc: a fillable shape's fill color (missing: its line color), a text's background, a callout's box. tc: a callout's text.
const TARGETS = { rect: { line: 'c', fill: 'fc' }, ellipse: { line: 'c', fill: 'fc' }, cloud: { line: 'c', fill: 'fc' }, poly: { line: 'c', fill: 'fc' }, text: { text: 'c', fill: 'fc' }, callout: { line: 'c', fill: 'fc', text: 'tc' } };
let colorTarget = 'line'; // the picker's pick
// The picked target's key for a type; a type without that target gets its first.
const keyOf = t => TARGETS[t]?.[colorTarget] ?? Object.values(TARGETS[t] ?? { line: 'c' })[0];
// The color a target shows (null: none). A fillable shape's fill is its line color until one is picked, and none while Fill is off.
const colorOf = (s, t, key) => key !== 'fc' ? s[key] : 'fill' in STYLES[t] ? (s.fill ? s.fc ?? s.c : null) : s.fc ?? null;
// What a swatch (null: the none swatch) changes: on a fillable shape's fill, a color also turns Fill on (`on`: the fill it
// has, else the tool's last), and none turns it off.
const swatch = (t, key, v, on) => key !== 'fc' || !('fill' in STYLES[t]) ? { [key]: v } : v ? { fc: v, fill: on } : { fill: false };
// Fill's menu: none, solid and the patterns (markup.js PATTERNS), in this order.
const FILLS = [['none', 'None'], ['solid', 'Solid'], ['fwd', 'Diagonal ///'], ['back', 'Diagonal \\\\\\'], ['vert', 'Vertical |||'], ['horiz', 'Horizontal ==='],
  ['grid', 'Grid ###'], ['cross', 'Crosshatch ×××'], ['dot1', 'Halftone light'], ['dot2', 'Halftone medium'], ['dot3', 'Halftone heavy'],
  ['herring', 'Herringbone'], ['brick', 'Running bond brick'], ['check', 'Checkerboard']];
// What the dock shows: the selected shape's style (in screen pixels), else the tool's.
const styleNow = s => s ? { ...s, w: s.w / dpr, size: s.size / dpr } : styleOf(tool);
const measure = new OffscreenCanvas(1, 1).getContext('2d');
measure.font = '600 100px system-ui, sans-serif';
const emOf = text => text.split('\n').reduce((m, l) => Math.max(m, measure.measureText(l).width), 0) / 100;

function render() {
  const W = shot.naturalWidth;
  if (!W) return;
  let drawn = shapes;
  if (editing != null) {
    const s = shapes[editing], k = shot.clientWidth / W, p = s.tip ? PAD * s.size : 0, H = shot.naturalHeight, b = bounds(s);
    Object.assign(edit.style, editBox(s, b, off, W, H, p), { font: `600 ${s.size * k}px/${LH} system-ui, sans-serif`, color: s.tip ? s.tc ?? '#111' : s.c, background: s.tip || s.fc ? 'transparent' : ['#ffffff', '#fdd835'].includes(s.c) ? '#000c' : '' });
    // A callout (or a text with a background) being typed keeps its box, and tail, sized to the editor (at least 2ch wide, with the caret).
    if (s.tip || s.fc) { const v = clean(edit.value); drawn = shapes.with(editing, retext(s, v, Math.max(emOf(v), edit.offsetWidth / (s.size * k)), off)); }
  }
  ink.innerHTML = toSvg(drawn, { ...off, w: W, h: shot.naturalHeight }, 12 * W / shot.clientWidth, dpr);
  // The editor shows the text being typed: hide the drawn text (a callout's box and tail, a text's background stay).
  if (editing != null) ink.querySelector(`[data-i="${editing}"]${shapes[editing].tip || shapes[editing].fc ? ' > text' : ''}`).style.visibility = 'hidden';
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
  const now = styleNow(s), t = s?.type ?? tool, key = keyOf(t), tg = TARGETS[t] ?? {}, color = colorOf(now, t, key);
  for (const b of document.querySelectorAll('[data-tool], [data-c], [data-fill], [data-see], [data-cmd]')) {
    const d = b.dataset;
    if (d.cmd) b.disabled = d.cmd === 'undo' ? !step : d.cmd === 'redo' ? step === hist.length - 1 : !s;
    else b.setAttribute('aria-pressed', d.tool ? d.tool === tool : d.c ? (d.c === 'none' ? null : d.c) === color : 'see' in d ? !!now.see : !!now.fill);
  }
  // The target picker shows each target's color; the none swatch is only for a fill.
  $('targets').hidden = !TARGETS[t];
  for (const b of $('targets').children) {
    const k = tg[b.dataset.target], c = k && colorOf(now, t, k);
    b.hidden = !k;
    b.setAttribute('aria-pressed', k === key);
    b.classList.toggle('none', !c);
    b.style.setProperty('--c', c || 'transparent');
  }
  $('nonec').hidden = key !== 'fc';
  const kind = now.fill === true ? 'solid' : now.fill || 'none';
  for (const b of $('fks').children) b.setAttribute('aria-pressed', b.dataset.fk === kind);
  $('density').value = now.dn ?? 1;
  $('opacity').value = Math.round((now.op ?? 0.4) * 100);
  $('opval').textContent = $('opacity').value + '%';
  // The weight shows as the line itself: its color, and its thickness on screen (a highlighter draws 4×), up to 16 px.
  Object.assign($('wprev').style, { height: Math.max(1, Math.min(16, Math.round(now.w * (t === 'hl' ? 4 : 1)))) + 'px', background: now.c });
  // The dock shows only what applies to the selected shape, else to the tool: c(olor) w(idth) f(ill) s(ize) d(elete). Empty hides it.
  $('props').dataset.k = (KINDS[s?.type ?? tool] + (s ? ' d' : '')).trim();
  $('tsize').textContent = now.size ? Math.round(now.size) : '';
  $('wval').textContent = now.w ? Math.round(now.w) : '';
  report();
}
// Each history step is [shapes, crop].
function commit() {
  const j = JSON.stringify([shapes, crop]);
  if (j !== hist[step]) {
    hist.length = ++step;
    hist.push(j);
  }
  render();
}
function go(d) {
  if (!hist[step + d]) return;
  step += d;
  [shapes, crop] = JSON.parse(hist[step]);
  cur = null;
  showCrop(); // every crop in the history was applied here, so its image is in crops
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
// Sliders keep theirs: without it they can't be dragged.
$('tools').onmousedown = $('props').onmousedown = $('zoombar').onmousedown = $('savemenu').onmousedown = $('fillmenu').onmousedown = $('seemenu').onmousedown = $('status').onmousedown = e => e.target?.type === 'range' || e.preventDefault();
// Fill's menu, with a preview of each fill in the text color.
$('fks').innerHTML = FILLS.map(([k, n]) => `<button data-fk="${k}" aria-label="${n}" data-tip="" class="tip-up"><svg viewBox="0 0 20 20">${
  k === 'none' ? '<rect x=".5" y=".5" width="19" height="19" rx="3" fill="none" stroke="currentColor" stroke-opacity=".35"/><path d="M4 16 16 4" stroke="var(--danger)" stroke-width="1.5"/>'
    : k === 'solid' ? '<rect width="20" height="20" rx="3" fill="currentColor"/>'
    : `<defs>${pattern('pv-' + k, k, 'currentColor', 3)}</defs><rect width="20" height="20" rx="3" fill="url(#pv-${k})"/>`}</svg></button>`).join('');
$('tools').onclick = $('props').onclick = ({ target, detail }) => {
  if (gesture) return;
  // A polygon being drawn is styled like a selected shape, but isn't committed until it closes.
  const d = target.closest('button')?.dataset ?? {}, i = cur ?? poly, s = shapes[i];
  // Weight and text size −/+ step on press (see onpointerdown below); a click from the keyboard (detail 0) is one step.
  if (d.step) {
    if (!detail) { stepStyle(d.step, +d.d); if (editing == null && poly == null) commit(); }
    return;
  }
  // Tool, Undo, Redo and Delete end an open edit first; on an empty new text that just cancels it, so Undo doesn't also undo the last commit.
  if (editing != null && (d.tool || d.cmd)) {
    const empty = !edit.value.trimEnd();
    // An existing text cleared to empty: drop the edit uncommitted, so the command acts on the saved history.
    if (empty && d.cmd && shapes[editing].text) { editing = null; edit.hidden = true; }
    else {
      finishEdit();
      if (empty && d.cmd) return render();
    }
  }
  if (d.tool || d.cmd) endPoly();
  if (d.tool) {
    if (cropping()) endCrop();
    tool = stage.dataset.tool = d.tool;
    cur = null;
  } else if (d.cmd) { if (cropping()) endCrop(); ({ undo: () => go(-1), redo: () => go(1), del: remove })[d.cmd](); }
  else {
    // A style button restyles the selected shape and sets its tool's style (the next shape of that kind gets it too).
    // The target picker picks what the swatches color.
    if (d.target) { colorTarget = d.target; return render(); }
    // Fill's button turns the last fill on and off; its menu picks one (and makes it the last).
    const t = s?.type ?? tool, now = styleNow(s), on = now.fill || styleOf(t).last || 'solid';
    const ch = d.c ? swatch(t, keyOf(t), d.c === 'none' ? null : d.c, on) : 'fill' in d ? { fill: now.fill ? false : on }
      : d.fk ? (d.fk === 'none' ? { fill: false } : { fill: d.fk, last: d.fk }) : 'see' in d ? { see: !now.see } : null;
    if (!ch) return;
    return restyle(ch);
  }
  render();
};
// Sets the selected shape's (or the polygon being drawn's) style and its tool's, or the tool's. Committed unless `held`
// (a slider being dragged) or the shape isn't in the history yet (an open edit commits its style with its text).
function restyle(ch, held) {
  const i = cur ?? poly, s = shapes[i];
  setStyle(s?.type ?? tool, ch);
  if (s) {
    const { last, ...sc } = ch;
    shapes[i] = { ...s, ...sc };
  }
  if (s && !held && editing == null && poly == null) commit();
  else render();
}
// Density scales every pattern's spacing; dragging it is one undo step.
$('density').oninput = ({ target }) => restyle({ dn: +target.value }, true);
$('density').onchange = () => editing == null && poly == null && commit();
// Opacity of a see-through shape; moving it turns See-through on (off, it would change nothing).
$('opacity').oninput = ({ target }) => restyle({ see: true, op: target.value / 100 }, true);
$('opacity').onchange = $('density').onchange;
// One step of weight (1–16 screen px) or text size (the size list) for the selected shape and its tool, or the tool.
function stepStyle(k, d) {
  const i = cur ?? poly, s = shapes[i], now = styleNow(s), v = k === 'w' ? Math.min(16, Math.max(1, Math.round(now.w) + d)) : nextSize(now.size, d);
  setStyle(s?.type ?? tool, { [k]: v });
  if (s && k in s) shapes[i] = { ...s, [k]: v * dpr };
  render();
}
// Holding − or + repeats: one step, then after 400 ms ~12 steps/s until release or the pointer leaves.
// A held run on a selected shape is one undo step (an open text edit commits it with its text).
$('props').onpointerdown = e => {
  const b = e.target.closest('[data-step]');
  if (!b || e.button || gesture) return;
  const once = () => stepStyle(b.dataset.step, +b.dataset.d);
  once();
  let t = setTimeout(() => { t = setInterval(once, 83); }, 400);
  b.onpointerup = b.onpointerleave = b.onpointercancel = () => {
    clearTimeout(t);
    clearInterval(t);
    b.onpointerup = b.onpointerleave = b.onpointercancel = null;
    if (editing == null && poly == null) commit();
  };
};

function startEdit(i) {
  editing = cur = i;
  edit.value = shapes[i].text;
  edit.hidden = false;
  render();
  edit.focus();
  // focus() won't scroll an editor that is in the viewport but under the fixed header or bottom dock.
  const r = edit.getBoundingClientRect(), dock = $('props').getBoundingClientRect();
  const dy = clearScroll(r.top, r.bottom, header.offsetHeight, dock.height ? dock.top : innerHeight);
  if (dy) scrollBy(0, dy);
}
// Click away or Esc keeps the text; emptied text removes its shape.
function finishEdit() {
  if (editing == null) return;
  const i = editing, text = clean(edit.value).trimEnd();
  editing = null;
  edit.hidden = true;
  if (text) shapes[i] = retext(shapes[i], text, emOf(text), off);
  else {
    shapes.splice(i, 1);
    cur = null;
  }
  commit();
}
// A window blur (Alt+Tab) keeps the textarea focused for when the window returns; only a real blur ends the edit.
edit.onblur = () => document.activeElement === edit || finishEdit();
edit.oninput = () => (shapes[editing]?.tip || shapes[editing]?.fc) && render(); // a callout's box, a text's background follow the text
// Menu Print's dialog is that kind of blur too, so finish before it lays out the page.
addEventListener('beforeprint', finishEdit);

function newShape(p) {
  const st = styleOf(tool), c = st.c, w = st.w * dpr, size = st.size * dpr, see = st.see || undefined, op = see && st.op;
  if (tool === 'hl') return { type: tool, c, w, pts: [p] };
  if (tool === 'pen') return { type: tool, c, w, see, op, pts: [p] };
  if (tool === 'line') return { type: tool, c, w, see, op, pts: [p, p] };
  // dpr: arrowheads, callout pointers and cloud scallops keep the minimum size they had when drawn
  if (tool === 'arrow') return { type: tool, c, w, dpr, see, op, pts: [p, p] };
  if (tool === 'callout') return { type: tool, c, w, dpr, size, fc: st.fc, tc: st.tc, x: p[0], y: p[1], text: '', em: 0, tip: p };
  return { type: tool, c, w, dpr, fill: st.fill, fc: st.fc, dn: st.dn, see, op, l: p[0], t: p[1], r: p[0], b: p[1] };
}
const atInk = ev => { const [x, y] = at(ev); return [x + off.x, y + off.y]; };

// Polygon: a click adds a point; a double-click, Enter or a click on the first point closes it; Backspace drops the last
// point; Esc cancels. Shift snaps the next edge to 45°. While drawing, poly is its index and its last point follows the
// pointer; it goes into the history when it closes. Anything else (a tool, Undo, Save...) closes it first.
let poly = null, polyAt = 0;
function polyClick(e) {
  const p = atInk(e), k = shot.naturalWidth / shot.clientWidth, near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 8 * k;
  if (poly == null) {
    const st = styleOf('poly');
    cur = null;
    poly = shapes.push({ type: 'poly', c: st.c, w: st.w * dpr, dpr, fill: st.fill, fc: st.fc, dn: st.dn, see: st.see || undefined, op: st.see && st.op, pts: [p, p], open: true }) - 1;
  } else {
    const s = shapes[poly], pts = s.pts.slice(0, -1), q = e.shiftKey ? snap(pts.at(-1), p) : p;
    // The second press of a double-click lands on the point the first one added.
    if ((e.timeStamp - polyAt < 500 && near(q, pts.at(-1))) || (pts.length >= 3 && near(p, pts[0]))) return endPoly();
    s.pts = [...pts, q, q];
  }
  polyAt = e.timeStamp;
  render();
}
// Closes the polygon being drawn; with fewer than 3 points there is nothing to keep.
function endPoly() {
  if (poly == null) return;
  const i = poly, { open, ...s } = shapes[i], pts = s.pts.slice(0, -1);
  poly = null;
  if (pts.length < 3) {
    shapes.splice(i, 1);
    return render();
  }
  shapes[i] = { ...s, pts };
  cur = i;
  commit();
}
function cancelPoly() {
  if (poly == null) return;
  shapes.splice(poly, 1);
  poly = null;
  render();
}
// Backspace: the last point goes; the pointer's point stays.
function dropPoint() {
  const s = shapes[poly];
  if (s.pts.length <= 2) return cancelPoly();
  s.pts.splice(-2, 1);
  render();
}
stage.addEventListener('pointermove', e => {
  if (poly == null || gesture) return;
  const s = shapes[poly], p = atInk(e);
  s.pts[s.pts.length - 1] = e.shiftKey ? snap(s.pts.at(-2), p) : p;
  render();
});
// A handle of the selected shape resizes it; otherwise Select picks and moves, Text places or edits on release, and the rest draw.
function markDown(e) {
  const p0 = atInk(e), h = e.target.closest('#pick') && e.target.dataset.h, hit = e.target.closest('#ink [data-i]'), hi = hit && +hit.dataset.i;
  const k = shot.naturalWidth / shot.clientWidth; // capture px per screen px, so drag thresholds don't change with zoom
  let i = cur, upd;
  if (tool === 'poly' && (poly != null || !h)) {
    stage.onpointermove = stage.onpointerup = null;
    return polyClick(e);
  }
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
    let moving = false; // a click with hand jitter is not a move
    upd = (ev, dx, dy) => (moving ||= Math.abs(dx) >= 3 * k || Math.abs(dy) >= 3 * k) ? move(from, dx, dy) : from;
  } else if (tool === 'text') {
    stage.onpointermove = null;
    // On release, so the press's own focus handling can't blur the new editor.
    stage.onpointerup = () => {
      stage.onpointerup = null;
      if (hit && shapes[hi].size) return startEdit(hi);
      const { c, fc } = styleOf(tool), size = styleOf(tool).size * dpr;
      startEdit(shapes.push({ type: 'text', c, fc, size, x: p0[0], y: newTextY(p0[1], size, off.y), text: '', em: 0 }) - 1);
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
  if (gesture || swapping || cutting || e.button || e.target === edit) return;
  const menu = document.querySelector(':popover-open'); // the press would draw under the Save menu: light dismiss doesn't fire on the stage
  if (menu) return menu.hidePopover();
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
  report();
};
onkeydown = e => {
  // Shortcuts follow the letter on Latin layouts (Dvorak too) and the physical key on others, like Chrome's print.
  const k = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : /^Key[A-Z]$/.test(e.code) ? e.code[3].toLowerCase() : e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'p') {
    e.preventDefault();
    finishEdit();
    return e.repeat || run('print');
  }
  if ((e.ctrlKey || e.metaKey) && k === 's') { // before the crop/text gates, which would swallow it; run() refuses mid-crop
    e.preventDefault();
    return e.repeat || run('save'); // a held Ctrl+S would queue a second Save dialog
  }
  if (isReload(e)) return e.preventDefault();
  if (gesture) return;
  if (e.key === 'Escape' && document.querySelector(':popover-open')) return; // the Save menu closes itself; this Esc is spent
  if (cropping()) {
    if (e.key === 'Escape') endCrop();
    if (e.key === 'Enter') { e.preventDefault(); applyCrop(); }
    return;
  }
  if (e.target === edit) {
    if (e.key === 'Escape' && !e.isComposing) finishEdit();
    return;
  }
  if (poly != null && ['Escape', 'Enter', 'Backspace'].includes(e.key)) {
    e.preventDefault?.();
    return e.key === 'Escape' ? cancelPoly() : e.key === 'Enter' ? endPoly() : dropPoint();
  }
  if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
    e.preventDefault();
    endPoly(); // a polygon being drawn closes first, as a toolbar Undo does
    go(k === 'y' || e.shiftKey ? 1 : -1);
  } else if ((e.ctrlKey || e.metaKey) && k === 'c') {
    e.preventDefault();
    if (!e.repeat) run('copy');
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && e.target.tagName !== 'INPUT') remove();
  else if (e.key === 'Escape') {
    // Esc steps back to Select, then closes the editor (the snip is already on the clipboard).
    if (tool === 'select' && cur == null) return e.repeat || closeEditor(); // a held Esc steps back but doesn't also close
    cur = null;
    tool = stage.dataset.tool = 'select';
    render();
  } else if (/^[a-z]$/.test(k) && !e.ctrlKey && !e.metaKey && !e.altKey && e.target.tagName !== 'INPUT') {
    // Single-letter tool keys: the button's data-key (shown in its tooltip) is the binding.
    document.querySelector(`[data-key="${k.toUpperCase()}"]`)?.click();
  }
};


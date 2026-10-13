// Run: node test.mjs
import assert from 'node:assert';
import { imagesToPdf, quietRow } from './src/pdf.js';

// 6x4 red JPEG
const JPG = atob('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAEAAYDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDkKKKK8U/TD//Z');

const pdf = imagesToPdf([{ jpg: JPG, w: 6, h: 4 }, { jpg: JPG, w: 6, h: 4 }]);
assert.match(pdf, /\/Kids\[3 0 R 6 0 R\]\/Count 2/);
// Every xref offset must point at its object header.
const xref = +pdf.match(/startxref\n(\d+)/)[1];
const offsets = [...pdf.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map(m => +m[1]);
assert.strictEqual(offsets.length, 8);
offsets.forEach((o, i) => assert(pdf.startsWith(`${i + 1} 0 obj`, o), `obj ${i + 1} offset`));
if (process.argv[2]) (await import('node:fs')).writeFileSync(process.argv[2], pdf, 'latin1');

// quietRow: 10px wide, 5 rows; rows 0-1 white, row 2 has one dot, rows 3-4 striped -> lowest blank row is 1.
const W = 10, data = new Uint8Array(W * 5 * 4).fill(255);
data.fill(0, (2 * W + 5) * 4, (2 * W + 6) * 4);
for (let r = 3; r < 5; r++) for (let x = 0; x < W; x += 2) data.fill(0, (r * W + x) * 4, (r * W + x + 1) * 4);
assert.strictEqual(quietRow(data, W, 5), 1);
assert.strictEqual(quietRow(data.subarray(2 * W * 4), W, 3), 0); // no blank row -> least busy row
// canvasToPdf on very narrow images: no 0-tall getImageData, and no page taller than the 720pt content area.
{
  const { canvasToPdf } = await import('./src/pdf.js');
  const prev = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class { constructor(w, h) { Object.assign(this, { width: w, height: h }); }
    getContext() { return { drawImage() {} }; } async convertToBlob() { return new Blob([JPG]); } };
  for (const w of [1, 2, 5, 8, 11]) for (const h of [40, Math.round(w * 4 / 3)]) { // 40: many pages; w*4/3: one full old-size page
    const canvas = { width: w, height: h, getContext: () => ({ getImageData(x, y, cw, ch) {
      if (!cw || !ch) throw new RangeError('IndexSizeError: source height is 0');
      return { data: new Uint8ClampedArray(cw * ch * 4).fill(255) };
    } }) };
    const out = Buffer.from(await (await canvasToPdf(canvas)).arrayBuffer()).toString('latin1');
    for (const m of out.matchAll(/q [\d.]+ 0 0 ([\d.]+) [\d.]+ (-?[\d.]+) cm/g))
      assert(+m[1] <= 720 && +m[2] >= 36, `w=${w}: page image ${m[1]}pt tall at y=${m[2]}`);
  }
  globalThis.OffscreenCanvas = prev;
}
// Markup geometry and serialization.
const { dragEdges, bounds, move, resize, toSvg, snap, nextSize, clean, editBox } = await import('./src/markup.js');
assert.deepStrictEqual(snap([0, 0], [10, 2]).map(Math.round), [10, 0]); // near-horizontal -> horizontal
assert.deepStrictEqual(snap([0, 0], [-1, -10]).map(Math.round), [0, -10]); // near-vertical -> vertical
assert.deepStrictEqual(snap([0, 0], [9, 11]).map(v => Math.round(v * 10)), [100, 100]); // diagonal, same length
assert.deepStrictEqual([nextSize(20, 1), nextSize(20, -1), nextSize(21, -1), nextSize(96, 1), nextSize(8, -1)], [24, 18, 20, 96, 8]);
assert.deepStrictEqual(dragEdges({ l: 10, t: 10, r: 20, b: 20 }, 'e', -15, 0), { l: 5, t: 10, r: 10, b: 20 }); // past the far edge flips
assert.deepStrictEqual(dragEdges({ l: 10, t: 10, r: 20, b: 20 }, 'nw', -50, 5, { l: 0, t: 0, r: 30, b: 30 }), { l: 0, t: 15, r: 20, b: 20 });
assert.deepStrictEqual(resize({ type: 'pen', pts: [[0, 0], [5, 5], [10, 10]] }, 'se', 10, 0).pts, [[0, 0], [10, 5], [20, 10]]);
assert.deepStrictEqual(resize({ type: 'hl', pts: [[0, 4], [10, 4]] }, 's', 0, 6).pts, [[0, 4], [10, 4]]); // a flat line doesn't divide by 0
assert.deepStrictEqual(resize({ type: 'line', pts: [[0, 0], [10, 10]] }, '1', 5, -5).pts, [[0, 0], [15, 5]]);
const label = { type: 'text', size: 10, em: 2, x: 10, y: 10, text: 'ab' }; // 20 x 12.5
assert.deepStrictEqual(bounds(resize(label, 'se', 0, 12.5)), { l: 10, t: 10, r: 50, b: 35 }); // double size, top-left stays
assert.deepStrictEqual(bounds(resize(label, 'nw', 0, -12.5)), { l: -10, t: -2.5, r: 30, b: 22.5 }); // bottom-right stays
assert.deepStrictEqual(bounds(resize(label, 'se', 20, 0)), { l: 10, t: 10, r: 50, b: 35 }); // a horizontal drag scales too
assert.deepStrictEqual(bounds(resize(label, 'se', -30, 0)), { l: 0, t: 10, r: 10, b: 16.25 }); // dragged past the left edge: half size, hanging left of the anchor
assert.ok(Number.isFinite(resize({ ...label, em: 0, text: "u200b" }, "se", 30, 0).size)); // zero-width text: no divide by 0
const call = move({ type: 'callout', size: 10, em: 1, x: 0, y: 0, text: 'a', tip: [50, 50], w: 2 }, 3, 4);
assert.deepStrictEqual([call.x, call.y, call.tip], [3, 4, [53, 54]]);
assert.deepStrictEqual(resize(call, 'tip', 1, 1).tip, [54, 55]);
const svg = toSvg([{ type: 'text', c: 'red', size: 10, em: 1, x: 0, y: 0, text: '<a>\n&b' }, { type: 'cloud', c: 'red', w: 2, l: 0, t: 0, r: 100, b: 50 }], { x: 5, y: 6, w: 100, h: 50 });
assert.match(svg, /viewBox="5 6 100 50" width="100" height="50"/); // the crop offset shifts the view, not the shapes
assert.match(svg, /&#60;a&#62;<\/tspan><tspan[^>]*>&#38;b</);
assert.strictEqual(svg.match(/A\d/g).length, 8 + 4 + 8 + 4); // 12-px scallops: 100 / 12 ≈ 8 per long side, 50 / 12 ≈ 4 per short
assert.doesNotMatch(svg, /opacity="0"/); // hit outlines only on screen
// Constants scale with dpr like the widths do: 2x the width at dpr 2 draws 2x the arrowhead and scallops.
assert.match(toSvg([{ type: 'arrow', c: 'red', w: 4, pts: [[0, 0], [1000, 0]] }], { x: 0, y: 0, w: 9, h: 9 }, 0, 2), /M1000 0L964 18L964 -18Z/); // head 3 * 4 + 12 * 2 = 36 long
assert.strictEqual(toSvg([{ type: 'cloud', c: 'red', w: 1, l: 0, t: 0, r: 100, b: 50 }], { x: 0, y: 0, w: 100, h: 50 }, 0, 2).match(/A\d/g).length, 4 + 2 + 4 + 2); // 24-px scallops
// A shape keeps the dpr it was drawn at, so later zoom changes don't change its export (bughunt L3 export-r1-3).
assert.match(toSvg([{ type: 'arrow', c: 'red', w: 4, dpr: 1, pts: [[0, 0], [1000, 0]] }], { x: 0, y: 0, w: 9, h: 9 }, 0, 2), /M1000 0L976 12L976 -12Z/);
assert.strictEqual(toSvg([{ type: 'cloud', c: 'red', w: 1, dpr: 1, l: 0, t: 0, r: 100, b: 50 }], { x: 0, y: 0, w: 100, h: 50 }, 0, 2).match(/A\d/g).length, 8 + 4 + 8 + 4);
const odd = toSvg([{ type: 'text', c: 'red', size: 10, em: 1, x: 0, y: 0, text: 'a\f\v\u0000\u001b￾￿\ud800b\tc' }], { x: 0, y: 0, w: 9, h: 9 });
assert.doesNotMatch(odd, /[^\n\r -퟿-�\u{10000}-\u{10ffff}]/u); // only XML-legal characters, or the export can't decode it
assert.match(odd, />ab c</); // a tab draws as the one space it's measured as
assert.match(toSvg([{ type: 'ellipse', c: '#000', w: 2, fill: true, l: 0, t: 0, r: 9, b: 9 }], { x: 0, y: 0, w: 9, h: 9 }), /fill="#000"/);
assert.strictEqual(toSvg([{ type: 'rect', c: 'red', w: 2, l: 0, t: 0, r: 9, b: 9 }], { x: 0, y: 0, w: 9, h: 9 }, 8).match(/stroke-width="10"/g).length, 1);
for (const [l, r] of [[0, 3], [0, 100], [0.04, 7.26]]) { // each arc must span the full box width, so rx is half the endpoint distance
  const [, x0, , rx, , x1] = toSvg([{ type: 'ellipse', c: 'red', w: 2, l, t: 0, r, b: 300 }], { x: 0, y: 0, w: 9, h: 9 }).match(/d="M([\d.]+) ([\d.]+)A([\d.]+) ([\d.]+) 0 1 0 ([\d.]+)/);
  assert.ok(Math.abs(+rx * 2 - (+x1 - +x0)) < 1e-9, `ellipse ${l}..${r}: rx ${rx} vs ${x0}..${x1}`);
}
// Text edit: a window blur (Alt+Tab) leaves the textarea focused, so it must not end the edit; a real blur does.
const onblur = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8').match(/edit\.onblur = .*/)[0];
for (const [active, ends] of [['edit', false], ['body', true]]) {
  let ended = false;
  const edit = {};
  new Function('edit', 'document', 'finishEdit', onblur)(edit, { activeElement: active === 'edit' ? edit : {} }, () => { ended = true; });
  edit.onblur();
  assert.strictEqual(ended, ends, `blur with ${active} focused`);
}
// Style per tool, remembered in localStorage (screen px): restyling a selected shape sets its tool's style, not the others'.
const SRC = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
const STYLE_SRC = SRC.match(/const RED = [\s\S]*?\nconst styleNow = .*/)[0]; // styles, color targets, styleNow
// The toolbar's click handler with the style code, over fake storage; returns { click(dataset), get() }.
const toolbar = ({ shapes = [], cur = null, editing = null, tool = 'select', dpr = 1, store = {}, edit = { value: '' }, log = [] } = {}) => {
  const tools = {};
  const get = new Function('$', 'shapes', 'commit', 'render', 'finishEdit', 'go', 'edit', 'localStorage', 'nextSize', 'cropping', 'stage',
    `let gesture = false, poly = null, endPoly = () => {}, cur = ${cur}, editing = ${editing}, tool = '${tool}', dpr = ${dpr}, remove; ${STYLE_SRC}
    ${SRC.match(/\$\('tools'\)\.onmousedown = .*/)[0]}; ${SRC.match(/\$\('tools'\)\.onclick = [\s\S]*?\n};/)[0]} ${SRC.match(/function stepStyle\([\s\S]*?\n\}/)[0]} ${SRC.match(/function restyle\([\s\S]*?\n\}/)[0]}
    return () => ({ cur, editing, styleOf });`)(
    () => tools, shapes, () => log.push('commit'), () => {}, () => log.push('finish'), () => log.push('go'), edit, store, nextSize, () => false, { dataset: {} });
  return { tools, click: dataset => tools.onclick({ target: { closest: () => ({ dataset }) } }), get, store, log };
};
{
  const shapes = [{ type: 'rect', c: 'red', w: 8, fill: false }, { type: 'line', c: 'red', w: 8, pts: [] }];
  const t = toolbar({ shapes, cur: 0, dpr: 2 });
  t.click({ fill: '' });
  assert.deepStrictEqual([shapes[0].fill, t.get().styleOf('rect').fill, t.get().styleOf('ellipse').fill], ['solid', 'solid', false], 'Fill on a selected rect');
  t.click({ c: 'blue' });
  assert.deepStrictEqual([shapes[0].c, t.get().styleOf('rect').c, t.get().styleOf('line').c], ['blue', 'blue', '#e53935'], 'color went to another tool');
  const u = toolbar({ shapes, cur: 1, dpr: 2, store: t.store });
  u.click({ step: 'w', d: '-1' }); // from the keyboard: one step
  assert.deepStrictEqual([shapes[1].w, u.get().styleOf('line').w], [6, 3], 'weight is picked in screen px, stored in capture px');
  assert.ok(u.log.includes('commit'));
  assert.strictEqual(JSON.parse(t.store['style.rect']).c, 'blue', 'not in localStorage');
  t.store['style.pen'] = '{oops';
  assert.strictEqual(t.get().styleOf('pen').c, '#e53935', 'corrupt storage did not fall back to the default');
  const v = toolbar({ tool: 'arrow' });
  v.click({ c: 'green' });
  assert.strictEqual(v.get().styleOf('arrow').c, 'green', 'swatch with no selection did not set the tool style');
}
// Delete/Backspace on the Format or Quality radios must not delete the selected shape.
globalThis.document = { querySelector: () => null }; // no Save menu open
globalThis.endPoly = () => {}; // no polygon being drawn, for the run() harnesses
globalThis.isReload = (await import('./src/markup.js')).isReload; // editor.js imports it; the onkeydown harnesses below see it as a global
// Ctrl+S while typing a label or cropping must reach Save (run handles the crop case), not be swallowed.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const ran = [], edit = {};
  let prevented = 0, crop = false;
  const k = new Function('run', 'finishEdit', 'cropping', 'marking', 'remove', 'edit', 'go', 'render', 'stage', `let gesture = false, poly = null, endPoly = () => {}, cur = 0, tool = 'select', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    a => ran.push(a), () => {}, () => crop, () => true, () => {}, edit, () => {}, () => {}, { dataset: {} });
  k({ ctrlKey: true, key: 's', target: edit, preventDefault: () => prevented++ });
  crop = true;
  k({ ctrlKey: true, key: 's', target: { tagName: 'BODY' }, preventDefault: () => prevented++ });
  assert.ok(prevented === 2 && ran.join() === 'save,save', 'Ctrl+S in the text editor or mid-crop was swallowed');
}
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  let removed = 0;
  const f = new Function('run', 'finishEdit', 'cropping', 'marking', 'remove', 'edit', 'go', 'render', 'stage', `let gesture = false, poly = null, endPoly = () => {}, cur = 0, tool = 'select', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    () => {}, () => {}, () => false, () => true, () => { removed++; }, {}, () => {}, () => {}, { dataset: {} });
  f({ key: 'Delete', target: { tagName: 'INPUT' } });
  f({ key: 'Backspace', target: { tagName: 'INPUT' } });
  assert.strictEqual(removed, 0, 'Delete on a radio removed the shape');
  f({ key: 'Delete', target: { tagName: 'BODY' } });
  assert.strictEqual(removed, 1);
  // Ctrl+P on a non-Latin layout (e.key 'з', e.code 'KeyP') must still be intercepted.
  const ran = [];
  const g = new Function('run', 'finishEdit', 'cropping', 'marking', 'remove', 'edit', 'go', 'render', 'stage', `let gesture = false, poly = null, endPoly = () => {}, cur = 0, tool = 'select', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    a => ran.push(a), () => {}, () => false, () => true, () => {}, {}, () => {}, () => {}, { dataset: {} });
  let prevented = 0;
  g({ ctrlKey: true, key: 'з', code: 'KeyP', target: { tagName: 'BODY' }, preventDefault: () => prevented++ });
  assert.ok(prevented === 1 && ran[0] === 'print', 'Ctrl+P on a non-Latin layout was not intercepted');
  g({ ctrlKey: true, key: 'l', code: 'KeyP', target: { tagName: 'BODY' }, preventDefault: () => prevented++ }); // Dvorak Ctrl+L
  assert.ok(prevented === 1 && ran.length === 1, 'Ctrl+L on Dvorak was taken for print');
  const steps = [];
  const h = new Function('run', 'finishEdit', 'cropping', 'marking', 'remove', 'edit', 'go', 'render', 'stage', `let gesture = false, poly = null, endPoly = () => {}, cur = 0, tool = 'select', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    () => {}, () => {}, () => false, () => false, () => {}, {}, d => steps.push(d), () => {}, { dataset: {} });
  h({ metaKey: true, key: 'z', target: { tagName: 'BODY' }, preventDefault: () => {} });
  h({ metaKey: true, shiftKey: true, key: 'z', target: { tagName: 'BODY' }, preventDefault: () => {} });
  assert.deepStrictEqual(steps, [-1, 1], 'Cmd+Z / Cmd+Shift+Z did not undo / redo');
  // Non-Latin layouts: Ctrl+Z/S and tool keys follow the physical key (Russian я = KeyZ, ы = KeyS, к = KeyR).
  globalThis.document = { querySelector: q => q === '[data-key="R"]' ? { click: () => steps.push('R') } : null };
  const ranRu = [];
  const r = new Function('run', 'finishEdit', 'cropping', 'marking', 'remove', 'edit', 'go', 'render', 'stage', `let gesture = false, poly = null, endPoly = () => {}, cur = 0, tool = 'select', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    a => ranRu.push(a), () => {}, () => false, () => false, () => {}, {}, d => steps.push(d), () => {}, { dataset: {} });
  r({ ctrlKey: true, key: 'я', code: 'KeyZ', target: { tagName: 'BODY' }, preventDefault: () => {} });
  r({ ctrlKey: true, key: 'ы', code: 'KeyS', target: { tagName: 'BODY' }, preventDefault: () => {} });
  r({ key: 'к', code: 'KeyR', target: { tagName: 'BODY' } });
  assert.deepStrictEqual([steps.slice(2), ranRu], [[-1, 'R'], ['save']], 'shortcuts dead on a non-Latin layout');
  globalThis.document = { querySelector: () => null };
  // Esc during IME composition belongs to the IME; it must not end the edit.
  let fin = 0;
  const edit = {};
  const m = new Function('run', 'finishEdit', 'cropping', 'marking', 'remove', 'edit', 'go', 'render', 'stage', `let gesture = false, poly = null, endPoly = () => {}, cur = 0, tool = 'select', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    () => {}, () => fin++, () => false, () => true, () => {}, edit, () => {}, () => {}, { dataset: {} });
  m({ key: 'Escape', isComposing: true, target: edit });
  assert.strictEqual(fin, 0, 'Esc during IME composition ended the edit');
  m({ key: 'Escape', target: edit });
  assert.strictEqual(fin, 1);
  // Esc with the Save menu open only closes the menu: it must not also end a crop or a text edit (editor-r1-5+editor-r2-2).
  globalThis.document = { querySelector: q => q === ':popover-open' ? {} : null };
  let ended = 0; globalThis.endCrop = () => ended++;
  const p = new Function('run', 'finishEdit', 'cropping', 'marking', 'remove', 'edit', 'go', 'render', 'stage', `let gesture = false, poly = null, endPoly = () => {}, cur = 0, tool = 'select', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`);
  p(() => {}, () => {}, () => true, () => true, () => {}, edit, () => {}, () => {}, { dataset: {} })({ key: 'Escape', target: {} });
  p(() => {}, () => fin++, () => false, () => true, () => {}, edit, () => {}, () => {}, { dataset: {} })({ key: 'Escape', target: edit });
  assert.deepStrictEqual([ended, fin], [0, 1], 'Esc closing the Save menu also ended the crop / text edit');
  globalThis.document = { querySelector: () => null };
}
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8'), edit = {};
  // editor-r2-5: a held Esc steps back to Select but its auto-repeat must not close the editor.
  let closed = 0; globalThis.closeEditor = () => closed++;
  const held = new Function('run', 'finishEdit', 'cropping', 'marking', 'remove', 'edit', 'go', 'render', 'stage', `let gesture = false, poly = null, endPoly = () => {}, cur = null, tool = 'rect', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    () => {}, () => {}, () => false, () => true, () => {}, edit, () => {}, () => {}, { dataset: {} });
  held({ key: 'Escape', target: {} }); held({ key: 'Escape', target: {}, repeat: true });
  assert.strictEqual(closed, 0, 'held Esc closed the editor');
  held({ key: 'Escape', target: {} });
  assert.strictEqual(closed, 1);
}
// Fit in a window shorter than the header must not go to a zero or negative scale.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const shot = { naturalWidth: 800, naturalHeight: 600, style: {} }, label = {};
  const [apply, get] = new Function('$', 'shot', 'header', 'document', 'innerHeight', 'devicePixelRatio', 'render', `let zoom = 'fit', scale = 1; ${src.match(/function applyZoom\(\) \{[\s\S]*?\n\}/)[0]} return [applyZoom, () => scale];`)(
    () => label, shot, { offsetHeight: 90 }, { documentElement: { clientWidth: 1000 }, body: { style: { setProperty() {} } } }, 100, 1, () => {});
  apply();
  assert.ok(get() > 0, `fit scale ${get()} in a short window`);
  // Fit with a vertical scrollbar that goes away once the capture shrinks: size for the width without it.
  const wide = { naturalWidth: 2000, naturalHeight: 400, style: {} };
  const doc = { documentElement: { get clientWidth() { return parseFloat(wide.style.width) > 1500 ? 983 : 1000; } }, body: { style: { setProperty() {} } } };
  wide.style.width = '3000px'; // zoomed in: tall page with a scrollbar
  const [apply2, get2] = new Function('$', 'shot', 'header', 'document', 'innerHeight', 'devicePixelRatio', 'render', `let zoom = 'fit', scale = 1; ${src.match(/function applyZoom\(\) \{[\s\S]*?\n\}/)[0]} return [applyZoom, () => scale];`)(
    () => label, wide, { offsetHeight: 90 }, doc, 900, 1, () => {});
  apply2();
  assert.equal(get2(), (1000 - 32) / 2000, 'Fit kept the width of a scrollbar that went away');
  // A header that changes height (status text, Quality select) re-runs the Fit math, not only the page padding.
  let ro, zoomed = 0;
  new Function('ResizeObserver', 'document', 'header', 'applyZoom', src.match(/.*new ResizeObserver\(.*/)[0])(
    class { constructor(f) { ro = f; } observe() {} }, { body: { style: {} } }, { offsetHeight: 120 }, () => zoomed++);
  ro();
  assert.equal(zoomed, 1, 'header resize did not re-run applyZoom');
  // Fit width where the capture needs a vertical scrollbar only at the wider width must settle, not flip every frame (editor-r2-1).
  const cap = { naturalWidth: 1200, naturalHeight: 700, style: {} }, cwNow = () => parseFloat(cap.style.width) * 7 / 12 > 560 ? 985 : 1000;
  let ro2;
  const apply3 = new Function('$', 'shot', 'header', 'document', 'innerHeight', 'devicePixelRatio', 'render', 'ResizeObserver', `let zoom = 'width', scale = 1; ${src.match(/.*new ResizeObserver\(.*/)[0]}\n${src.match(/function applyZoom\(\) \{[\s\S]*?\n\}/)[0]} return applyZoom;`)(
    () => label, cap, { offsetHeight: 90 }, { documentElement: { get clientWidth() { return cwNow(); } }, body: { style: { setProperty() {} } } }, 722, 1, () => {},
    class { constructor(f) { ro2 = f; } observe() {} });
  let last = cwNow(), fires = 0;
  apply3();
  while (cwNow() !== last && fires < 10) { last = cwNow(); fires++; ro2(); } // the fixed header's width follows the scrollbar
  assert.ok(fires < 10, 'Fit width kept flipping the scrollbar');
  assert.ok(parseFloat(cap.style.width) + 32 <= cwNow(), `Fit width ${cap.style.width} overflows ${cwNow()}px`);
}
// Re-croppable crop: a crop is a view of the original, undoable; Crop again shows the original with the crop as the box.
// From Apply until the new image has loaded, a gesture would mix the old image's geometry with the new offset.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8'), m = re => src.match(re)[0];
  let release, downs = 0;
  const cls = new Set(), stage = { classList: { contains: c => cls.has(c), add: c => cls.add(c), remove: c => cls.delete(c) }, setPointerCapture() {} };
  const shot = { naturalWidth: 100, naturalHeight: 80 }, els = {}, $ = id => (els[id] ??= { style: {}, setAttribute() {} }), sel = $('sel');
  const t = new Function('$', 'stage', 'shot', 'sel', 'edit', 'document', 'URL', 'OffscreenCanvas', 'createImageBitmap', 'cropDown', 'markDown', 'applyZoom', 'show', 'report', 'render', 'finishEdit', 'place',
    `let gesture = false, poly = null, endPoly = () => {}, editing = null, swapping = false, png = 'orig', off = { x: 0, y: 0 }, shapes = [], hist = ['[[],null]'], step = 0, cur = null;
    const cropping = () => stage.classList.contains('cropping');
    ${m(/let box, full, crop = .*/)}
    ${m(/const original = .*/)}
    ${m(/function setShot\([\s\S]*?\n\}/)} ${m(/function showCrop\([\s\S]*?\n\}/)} ${m(/function endCrop\([\s\S]*?\n\}/)}
    ${m(/async function applyCrop\([\s\S]*?\n\}/)} ${m(/\$\('crop'\)\.onclick = [\s\S]*?\n\};/)} ${m(/\$\('cropreset'\)\.onclick = .*/)} ${m(/const state = .*/)}
    ${m(/function commit\(\) \{[\s\S]*?\n\}/)} ${m(/function go\(d\) \{[\s\S]*?\n\}/)}
    ${m(/stage\.onpointerdown = [\s\S]*?\n\};/)} ${m(/stage\.onpointercancel = [\s\S]*?\n\};/)} ${m(/shot\.onload = [\s\S]*?\n\};/)}
    return { applyCrop, endCrop, go, state, get: () => ({ png, off, crop, box }), setBox: b => { box = b; } };`)(
    $, stage, shot, sel, {}, { activeElement: { blur() {} }, querySelector: () => null }, { createObjectURL: b => b, revokeObjectURL() {} },
    class { getContext() { return { drawImage: i => { this.i = i; } }; } convertToBlob() { return `crop ${this.i.join()}`; } },
    (b, ...r) => release === undefined ? new Promise(res => { release = () => res(r); }) : r,
    () => downs++, () => downs++, () => {}, () => {}, () => {}, () => {}, () => {}, () => {});
  const down = () => stage.onpointerdown({ button: 0, pointerId: 1, target: {}, preventDefault() {} }) || stage.onlostpointercapture({});
  shot.onload(); // the original: 100 x 80
  const blank = t.state();
  cls.add('cropping'); t.setBox({ l: 0, t: 0, r: 50, b: 40 });
  const applying = t.applyCrop();
  down();
  release();
  await applying;
  down();
  assert.strictEqual(downs, 0, 'gesture started while the crop was encoding or the cropped image swapping in');
  shot.onload();
  down();
  assert.strictEqual(downs, 1);
  assert.deepStrictEqual(t.get().off, { x: 0, y: 0 });
  assert.strictEqual(t.get().png, 'crop 0,0,50,40');
  assert.notStrictEqual(t.state(), blank, 'a crop at (0,0) counted as saved');
  // Crop again: the original shows, with the crop as the box; Cancel goes back to the crop.
  els.crop.onclick();
  assert.deepStrictEqual([t.get().png, t.get().box], ['orig', { l: 0, t: 0, r: 50, b: 40 }]);
  t.endCrop();
  assert.deepStrictEqual([t.get().png, cls.has('cropping')], ['crop 0,0,50,40', false]);
  // A second crop (in the original's pixels), then undo steps back through both.
  els.crop.onclick(); t.setBox({ l: 10, t: 5, r: 60, b: 45 });
  await t.applyCrop();
  assert.deepStrictEqual([t.get().png, t.get().off], ['crop 10,5,50,40', { x: 10, y: 5 }]);
  t.go(-1);
  assert.deepStrictEqual([t.get().png, t.get().off, t.get().crop], ['crop 0,0,50,40', { x: 0, y: 0 }, { x: 0, y: 0, w: 50, h: 40 }]);
  t.go(-1);
  assert.deepStrictEqual([t.get().png, t.get().off, t.state()], ['orig', { x: 0, y: 0 }, blank]);
  t.go(1); t.go(1);
  // Reset makes the box the whole capture; applying it is no crop at all.
  els.crop.onclick(); els.cropreset.onclick();
  assert.deepStrictEqual(t.get().box, { l: 0, t: 0, r: 100, b: 80 });
  await t.applyCrop();
  assert.deepStrictEqual([t.get().png, t.get().crop], ['orig', null]);
}
// Toolbar presses while a new text is open: the editor keeps focus (so blur can't delete the empty text first), a swatch styles the pending text, Undo only cancels it.
{
  const shapes = [{ type: 'text', c: 'red', size: 20, text: '' }], t = toolbar({ shapes, cur: 0, editing: 0, tool: 'text' });
  let prevented = 0;
  t.tools.onmousedown({ preventDefault: () => prevented++ });
  assert.strictEqual(prevented, 1, 'toolbar press moved focus out of the editor');
  t.click({ c: 'blue' });
  assert.strictEqual(shapes[0].c, 'blue', 'swatch did not style the pending text');
  assert.ok(!t.log.includes('commit'), 'swatch committed an empty text');
  t.log.length = 0;
  t.click({ cmd: 'undo' });
  assert.ok(!t.log.includes('go'), 'Undo on an empty new text also undid the previous commit');
}
// editor-r2-4: clearing an existing text then Undo must undo, not delete the shape as a new step.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const shapes = [{ type: 'text', c: 'red', size: 20, text: 'abc' }], tools = {}, log = [], edit = { value: '' };
  new Function('$', 'shapes', 'render', 'finishEdit', 'go', 'edit', `let gesture = false, poly = null, endPoly = () => {}, cur = 0, editing = 0, tool = 'select', remove; const cropping = () => false;
    ${src.match(/\$\('tools'\)\.onclick = [\s\S]*?\n};/)[0]}`)(() => tools, shapes, () => {}, () => log.push('finish'), () => log.push('go'), edit);
  tools.onclick({ target: { closest: () => ({ dataset: { cmd: 'undo' } }) } });
  assert.deepStrictEqual(log, ['go'], 'Undo after clearing an existing text deleted it instead of undoing');
  assert.ok(edit.hidden, 'editor left open');
}
// Print: if print() returns without firing afterprint (policy-blocked, throttled), .burned must not linger for menu Print.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const cls = new Set(), props = {}, p = { naturalWidth: 3840, style: { setProperty: (k, v) => { props[k] = v; } }, decode: async () => {}, removeAttribute() {} };
  // export-r2-2: a crop swapping #shot mid-encode resets body's --actual, so the burned image must carry its own width.
  const act = new Function('$', 'encode', 'document', 'URL', 'addEventListener', 'print', 'devicePixelRatio',
    `return {${src.match(/async print\(\) \{[\s\S]*?\n  \},/)[0]}}`)(
    () => p, async () => ({}), { body: { classList: { add: c => cls.add(c), remove: c => cls.delete(c) } } },
    { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, () => {},
    () => assert.strictEqual(props['--actual'], '1920px', 'printshot sized from --actual, not from the encoded image'), 2);
  await act.print();
  assert.ok(!cls.has('burned'), 'body.burned left set after a print() that never fired afterprint');
}
// Save: a failed write is reported, a cancelled dialog is silent; only a save that went through counts as saved (Esc won't ask).
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const els = {}, $ = id => (els[id] ??= { value: 'png', textContent: '' }), opts = { format: { value: 'png' } };
  let result;
  const [run, saved] = new Function('$', 'encode', 'invoke', 'png', 'state', 'opts', 'finishEdit', 'cropping',
    `let saved = 'blank', report = () => {}; const ACTIONS = {${src.match(/async save\(fmt\) \{[\s\S]*?\n  \},/)[0]}}; ${src.match(/let busy[\s\S]*?\n\}/)[0]}; return [run, () => saved];`)(
    $, async () => new Blob(['x']), async (cmd, body, o) => { assert.deepStrictEqual([cmd, o.headers.ext], ['save', 'png']); return result(); }, {}, () => 'drawn', opts, () => {}, () => false);
  result = () => { throw 'Access is denied. (os error 5)'; };
  await run('save');
  assert.strictEqual(els.status.textContent, 'Failed: Access is denied. (os error 5)', 'failed write not reported');
  result = () => null;
  await run('save');
  assert.strictEqual(els.status.textContent, '', 'cancelled dialog reported as a failure');
  assert.strictEqual(saved(), 'blank', 'a failed or cancelled save counted as saved');
  result = () => 'x.png';
  await run('save');
  assert.deepStrictEqual([els.status.textContent, saved()], ['Saved x.png', 'drawn']);
}
// Save/Copy with a text still open (toolbar presses keep the editor focused) must export the typed text, not the text from before the edit.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const els = {}, $ = id => (els[id] ??= { value: 'png', textContent: '' }), opts = { format: { value: 'png' } }, log = [];
  const run = new Function('$', 'png', 'state', 'opts', 'finishEdit', 'ACTIONS', 'cropping',
    `let saved, report = () => {}; ${src.match(/let busy[\s\S]*?\n\}/)[0]}; return run;`)(
    $, {}, () => 's', opts, () => log.push('finish'), { copy: async () => (log.push('encode'), 'Copied') }, () => false);
  await run('copy');
  assert.deepStrictEqual(log, ['finish', 'encode'], 'Copy exported before the open text edit was finished');
}
// Esc steps back to Select, then closes; closing with unsaved markup asks first.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const log = [], stage = { dataset: {} };
  const key = (cur, tool, marking = true) => new Function('run', 'finishEdit', 'cropping', 'marking', 'remove', 'edit', 'go', 'render', 'stage', 'closeEditor',
    `let gesture = false, poly = null, endPoly = () => {}, cur = ${cur}, tool = '${tool}', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    a => log.push(a), () => {}, () => false, () => marking, () => {}, {}, () => {}, () => log.push('render'), stage, () => log.push('close'))({ key: 'Escape', target: {} });
  key(0, 'select'); key('null', 'arrow');
  assert.deepStrictEqual(log, ['render', 'render'], 'Esc closed with a shape selected or a drawing tool picked');
  key('null', 'select');
  assert.deepStrictEqual(log.slice(2), ['close'], 'Esc with nothing to step back from did not close');
  globalThis.document = { querySelector: () => ({}) }; // Save menu open: Esc is the menu's
  key('null', 'select');
  assert.strictEqual(log.length, 3, 'Esc with the Save menu open stepped back or closed');
  globalThis.document = { querySelector: () => null };
  const ask = new Function('state', 'saved', 'confirm', 'invoke', `let modal; ${src.match(/const closeEditor = [\s\S]*?\n\};/)[0]} return closeEditor;`);
  const closed = [];
  ask(() => 'a', 'a', () => assert.fail('asked with nothing unsaved'), c => closed.push(c))();
  ask(() => 'b', 'a', () => false, c => closed.push(c))();
  assert.deepStrictEqual(closed, ['close'], 'closed despite a declined confirm');
}
// Editing text in a light swatch (White/Yellow) must not sit on #edit's near-white CSS background.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const line = src.match(/Object\.assign\(edit\.style, .*/)[0];
  const run = s => { const edit = { style: {} }; new Function('edit', 's', 'k', 'p', 'W', 'H', 'b', 'off', 'shot', 'LH', 'editBox', line)(edit, s, 1, 0, 100, 100, {}, { x: 0, y: 0 }, { naturalHeight: 100 }, 1.2, editBox); return edit.style; };
  assert.strictEqual(run({ x: 0, y: 0, size: 16, c: '#ffffff' }).background, '#000c', 'white text gets a dark edit background');
  assert.strictEqual(run({ x: 0, y: 0, size: 16, c: '#fdd835' }).background, '#000c', 'yellow text gets a dark edit background');
  assert.notStrictEqual(run({ x: 0, y: 0, size: 16, c: '#e53935' }).background, '#000c', 'red keeps the default light background');
}
// A huge paste (150k lines) or pen stroke must not overflow the spread-args limit.
{
  const big = Array.from({ length: 150000 }, (_, i) => [i, 1 - i]);
  assert.deepStrictEqual(bounds({ pts: big }), { l: 0, t: -149998, r: 149999, b: 1 }, 'bounds of a 150k-point stroke');
  const line = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8').match(/const emOf = .*/)[0];
  const measure = { measureText: l => ({ width: l.length * 10 }) };
  assert.strictEqual(new Function('measure', `${line} return emOf;`)(measure)('ab\n' + '\n'.repeat(150000)), 0.2, 'finishEdit measures a 150k-line text');
}
// A callout dragged up-left of its point grows away from the point, not back over it.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8').match(/function finishEdit[\s\S]*?\n}/)[0];
  const shapes = [{ type: 'callout', size: 10, x: 60, y: 60, text: '', em: 0, tip: [100, 100] }], measure = { measureText: l => ({ width: l.length * 60 }) };
  const { retext } = await import('./src/markup.js'), emOf = t => t.split('\n').reduce((m, l) => Math.max(m, measure.measureText(l).width), 0) / 100;
  const run = (shapes, value) => new Function('shapes', 'retext', 'emOf', 'clean', 'commit', 'edit', 'off', `let editing = 0, cur = 0; ${src}; finishEdit();`)(shapes, retext, emOf, clean, () => {}, { value }, { x: 0, y: 0 });
  run(shapes, 'abcdefgh\nx');
  const b = bounds(shapes[0]);
  assert.ok(b.r <= 100 && b.b <= 100, 'callout box covers its own point');
  // Near the image's left/top edge, growing away from the point stops at the edge rather than pushing the text off the capture.
  const edge = [{ type: 'callout', size: 10, x: 5, y: 5, text: '', em: 0, tip: [300, 300] }];
  run(edge, 'abcdefghijklmnop\nx\ny');
  assert.ok(edge[0].x >= 0 && edge[0].y >= 0, 'callout pushed off the image edge');
  // Pasted \f and other XML-illegal characters are dropped from the drawn text, so the stored text and its width drop them too.
  const ff = [{ type: 'callout', size: 10, x: 0, y: 0, text: '', em: 0, tip: [0, 0] }];
  run(ff, 'ab\f\f\fcd\u0000');
  assert.strictEqual(ff[0].em, 2.4, 'callout box measured stripped characters the export drops');
}
// Editing a text whose top is under the fixed header scrolls it clear of the header.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8').match(/function startEdit[\s\S]*?\n}/)[0];
  let dy = 0;
  const edit = { focus() {}, getBoundingClientRect: () => ({ top: 30, bottom: 60 }) };
  const { clearScroll } = await import('./src/markup.js'), $ = () => ({ getBoundingClientRect: () => ({ top: 500, height: 40 }) });
  new Function('shapes', 'edit', 'render', 'header', 'scrollBy', '$', 'clearScroll', `let editing, cur; ${src}; startEdit(0);`)([{ text: 'a' }], edit, () => {}, { offsetHeight: 50 }, (x, y) => { dy += y; }, $, clearScroll);
  assert.strictEqual(dy, -20, 'startEdit scrolls the editor out from under the header');
}
// Single-letter tool keys click the button whose data-key matches; other keys and Ctrl+letter don't.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8'), html = (await import('node:fs')).readFileSync('./src/index.html', 'utf8');
  const clicked = [];
  globalThis.document = { querySelector: q => q === ':popover-open' ? null : (clicked.push(q), { click() {} }) };
  const k = new Function('run', 'finishEdit', 'cropping', 'remove', 'edit', 'go', 'render', 'stage', 'closeEditor',
    `let gesture = false, poly = null, endPoly = () => {}, cur = null, tool = 'select', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    () => {}, () => {}, () => false, () => {}, {}, () => {}, () => {}, { dataset: {} }, () => {});
  for (const key of ['a', 'X', '"', ' ', '1']) k({ key, target: { tagName: 'BODY' } });
  k({ key: 'a', ctrlKey: true, target: { tagName: 'BODY' }, preventDefault() {} });
  k({ key: 'r', target: { tagName: 'INPUT' } });
  assert.deepStrictEqual(clicked, ['[data-key="A"]', '[data-key="X"]']);
  // Every tool has a dock entry, and every bound key exists once.
  const kinds = new Function(`${src.match(/const KINDS = .*/)[0]} return KINDS;`)();
  for (const [, t] of html.matchAll(/data-tool="(\w+)"/g)) assert.ok(t in kinds, `no dock kinds for tool ${t}`);
  const keys = [...html.matchAll(/data-key="(\w)"/g)].map(m => m[1]);
  assert.strictEqual(new Set(keys).size, keys.length, 'duplicate data-key');
  globalThis.document = { querySelector: () => null };
}
// A Copy pressed while an earlier one is still encoding runs after it, on what's on screen then, instead of being dropped (bughunt export-r3-1).
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8').match(/let busy[\s\S]*?\n}\n/)[0];
  const copied = [];
  let screen = 'no box', release;
  const ACTIONS = { async copy() { const at = screen; await new Promise(r => { release ??= r; if (release !== r) r(); }); copied.push(at); return 'Copied as PNG'; },
    async save() { copied.push('save'); return 'Saved'; } };
  const status = {};
  const run = new Function('ACTIONS', 'png', 'finishEdit', '$', 'state', 'opts', 'cropping', `let saved, report = () => {}; ${src} return run;`)(
    ACTIONS, {}, () => {}, () => status, () => screen, { format: {} }, () => false);
  const first = run('copy');
  screen = 'box';
  const second = run('copy');
  release();
  await first; await second;
  assert.deepStrictEqual(copied, ['no box', 'box'], 'second Copy during an encode is dropped');
  // A Save pressed while busy is dropped, not queued: a double-click on Save would open a second dialog.
  release = undefined;
  const third = run('copy');
  await run('save');
  release();
  await third;
  assert.deepStrictEqual(copied, ['no box', 'box', 'box'], 'a Save pressed during a Copy was queued');
}
// JPG/PDF have no alpha: a transparent PNG (Open with) must be flattened onto white, not black (bughunt export-r1-3).
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8').match(/async function encode[\s\S]*?\n}\n/)[0];
  for (const fmt of ['jpg', 'pdf']) {
    const log = [], ctx = { set fillStyle(v) { log.push('fill ' + v); }, fillRect: () => log.push('rect'), drawImage: () => log.push('img') };
    class OffscreenCanvas { constructor(w, h) { Object.assign(this, { width: w, height: h }); } getContext() { return ctx; } convertToBlob() { return {}; } }
    const encode = new Function('png', 'off', 'shapes', 'opts', 'createImageBitmap', 'OffscreenCanvas', 'canvasToPdf', `${src} return encode;`)(
      {}, {}, [], { quality: { value: '0.9' } }, async () => ({ width: 2, height: 2 }), OffscreenCanvas, () => ({}));
    await encode(fmt);
    assert.deepStrictEqual(log, ['fill #fff', 'rect', 'img'], fmt + ': transparent areas not flattened onto white');
  }
}
// An image that won't display (corrupt PNG with valid magic) must not stay saveable: Save would write the broken bytes and say "Saved" (export-r2-1).
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const status = {}, btn = {}, shot = {};
  const png = new Function('$', 'show', 'shot', 'document', `let png = 'blob'; ${src.match(/shot\.onerror = .*/)[0]} shot.onerror(); return png;`)(
    () => status, () => {}, shot, { querySelectorAll: () => [btn] });
  assert.ok(!png, 'a broken image left png set, so Save and Copy still run');
  assert.strictEqual(btn.disabled, true);
}
// Save/Copy/Print while a crop box is pending must not export the uncropped image (export-r3-2).
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const ran = [], status = {};
  const run = new Function('ACTIONS', 'png', '$', 'opts', 'finishEdit', 'state', 'cropping', `let busy = false, next = null, saved, report = () => {}; ${src.match(/async function run\(key\) \{[\s\S]*?\n\}/)[0]} return run;`)(
    { copy: async () => { ran.push('copy'); return 'Copied'; } }, {}, () => status, { format: {} }, () => {}, () => '', () => true);
  await run('copy');
  assert.deepStrictEqual(ran, [], 'Copy exported while a crop was pending');
}
// critic-r1-1: WebView2 reload keys would wipe unsaved markup; the editor must swallow them.
{
  const { isReload } = await import('./src/markup.js');
  for (const e of [{ key: 'F5' }, { key: 'F5', ctrlKey: true }, { key: 'r', ctrlKey: true }, { key: 'R', ctrlKey: true, shiftKey: true }, { key: 'BrowserRefresh' }, { key: 'к', code: 'KeyR', ctrlKey: true }])
    assert(isReload(e), JSON.stringify(e));
  for (const e of [{ key: 'r' }, { key: 'F6' }, { key: 's', ctrlKey: true }, { key: 'p', code: 'KeyR', ctrlKey: true }]) assert(!isReload(e), JSON.stringify(e));
}
console.log('ok');

// File-association ProgID must be namespaced: NSIS uses `name` as the HKCU\Software\Classes key and uninstall deletes it.
for (const a of JSON.parse((await import('node:fs')).readFileSync('./src-tauri/tauri.conf.json', 'utf8')).bundle.fileAssociations)
  assert.match(a.name, /^JustMark\./, 'fileAssociations name must be namespaced');
// Zoom pill, Save menu and status toast presses must not blur an open text editor (would delete an empty new text).
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const line = src.match(/.*\.onmousedown = e => e\.preventDefault\(\);/)[0];
  for (const id of ['tools', 'props', 'zoombar', 'savemenu', 'status']) assert(line.includes(`$('${id}')`), `${id} mousedown guard`);
}
// A Select click with sub-threshold jitter must not move the shape (no undo step, no dirty state).
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const stage = {}, shapes = [{ type: 'rect', l: 0, t: 0, r: 50, b: 50 }];
  const hit = { dataset: { i: '0' } };
  const md = new Function('stage', 'shapes', 'move', 'resize', 'snap', 'bounds', `let cur = null, tool = 'select', lastDown = 0, upd; const shot = { naturalWidth: 100, clientWidth: 100 };
    const render = () => {}, commit = () => {}, atInk = e => [e.x, e.y]; ${src.match(/function markDown\(e\) \{[\s\S]*?\n\}/)[0]} return markDown;`)(stage, shapes, move, resize, snap, bounds);
  md({ x: 10, y: 10, timeStamp: 0, target: { closest: s => s === '#pick' ? null : hit } });
  stage.onpointermove({ x: 11, y: 10 });
  assert.strictEqual(shapes[0].l, 0, '1px jitter moved the selected shape');
  stage.onpointermove({ x: 20, y: 10 });
  assert.strictEqual(shapes[0].l, 10, 'a real drag should move it');
}
// A failed crop encode must say so in the status bar, not just end crop mode silently (bughunt editor-r1-9).
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8').match(/async function applyCrop[\s\S]*?\n}\n/)[0];
  const status = { textContent: '' };
  let committed = 0;
  const [applyCrop, cut] = new Function('$', 'box', 'endCrop', 'createImageBitmap', 'OffscreenCanvas', 'original', 'commit', 'showCrop', 'cropping',
    `let full = [9, 9], crop = null, cutting = false; const crops = new Map(); ${src} return [applyCrop, () => cutting];`)(
    () => status, { l: 0, t: 0, r: 5, b: 5 }, () => {}, async () => { throw new Error('oom'); }, class {}, {}, () => committed++, () => {}, () => false);
  await applyCrop();
  assert.match(status.textContent, /oom/, 'crop failure was silent');
  assert.deepStrictEqual([committed, cut()], [0, false], 'a failed crop committed, or left gestures blocked');
}

// A swapped-in image that fails to load must clear `swapping`, or every stage gesture stays blocked (editor-r1-10).
{
  const line = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8').match(/shot\.onerror = .*/)[0];
  let swapping = true, png = 'x';
  const shot = {}, el = { textContent: '' }, $ = () => el, show = () => {}, document = { querySelectorAll: () => [] };
  eval(line); shot.onerror();
  assert.strictEqual(swapping, false, 'failed image load left swapping stuck on');
}
// editor-r2-3: a press on the capture with the Save menu open only closes the menu (light dismiss doesn't fire there).
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  let hidden = false, drawn = false;
  const menu = { hidePopover: () => { hidden = true; } };
  const stage = {}, document = { querySelector: () => menu, activeElement: { blur() {} } };
  const gesture = false, swapping = false, cutting = false, edit = {}, editing = null;
  const cropping = () => false, markDown = () => { drawn = true; }, cropDown = markDown, finishEdit = () => {};
  stage.setPointerCapture = () => {};
  eval(src.match(/stage\.onpointerdown = e => \{[\s\S]*?\n\};/)[0]);
  stage.onpointerdown({ button: 0, target: {}, preventDefault() {}, pointerId: 1 });
  assert.deepStrictEqual([hidden, drawn], [true, false], 'stage press with Save menu open drew instead of closing the menu');
}

{ // editor-r3-1: the text editing box must not run past the image edge, where the committed text is clipped
  const t = { x: 970, y: 580, size: 20, c: '#e53935', text: 'long line' };
  const e = editBox(t, bounds(t), { x: 0, y: 0 }, 1000, 600, 0);
  assert.strictEqual(e.maxWidth, '3%', 'edit box may grow past the right image edge');
  assert.strictEqual(e.maxHeight, '3.3333333333333335%', 'edit box may grow past the bottom image edge');
}
// clearScroll (bughunt editor-r4-2): an editor under the bottom dock scrolls up into view; the header still wins.
{
  const { clearScroll } = await import('./src/markup.js');
  assert.strictEqual(clearScroll(500, 540, 60, 520), 20); // under the dock -> scroll down 20
  assert.strictEqual(clearScroll(40, 80, 60, 520), -20); // under the header -> scroll up
  assert.strictEqual(clearScroll(100, 140, 60, 520), 0);
  assert.strictEqual(clearScroll(60, 600, 60, 520), 0); // taller than the gap: keep the top visible
}
// editor-r4-3: below ~700px the dock + zoom pill overflow #bottom's one row; a narrow-width rule must stack them.
{
  const css = (await import('node:fs')).readFileSync('./src/index.html', 'utf8');
  const mq = css.match(/@media \(max-width: (\d+)px\) \{([^@]*?#bottom[^@]*?)\n  \}/);
  assert(mq && +mq[1] >= 720, 'narrow-width rule for #bottom');
  assert.match(mq[2], /#zoombar \{[^}]*grid-row: 1/);
}
{ // editor-r5-2: a new text clicked near the image top starts at the top edge, not above it
  const { newTextY } = await import('./src/markup.js');
  assert.strictEqual(newTextY(3, 20, 0), 0);
  assert.strictEqual(newTextY(100, 20, 0), 100 - 20 * 1.25 / 2);
}
// editor-r5-3: fixed at left:50%, #status shrink-to-fits into 50vw unless its width is set explicitly.
{
  const css = (await import('node:fs')).readFileSync('./src/index.html', 'utf8');
  assert.match(css.match(/#status \{[^}]*\}/)[0], /width: max-content/);
}
// Auto copy's CF_DIB: bottom-up BGRA under a 40-byte header.
{
  const { toDib } = await import('./src/pdf.js');
  const d = toDib(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 1, 2), v = new DataView(d.buffer); // top pixel 1,2,3,4; bottom 5,6,7,8
  assert.deepStrictEqual([v.getUint32(0, true), v.getInt32(4, true), v.getInt32(8, true), v.getUint16(14, true), d.length], [40, 1, 2, 32, 48]);
  assert.deepStrictEqual([...d.slice(40)], [7, 6, 5, 8, 3, 2, 1, 4]);
}
// Auto copy: only when leaving with unsaved markup and the setting on; never for our own dialogs (modal, busy) or mid-crop.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const blur = ({ modal = false, busy = false, crop = false, editing = null, now = 'b', on = true }) => {
    const ran = [];
    const f = new Function('modal', 'busy', 'png', 'cropping', 'editing', 'state', 'saved', 'invoke', 'run',
      `let onblur; ${src.match(/onblur = async [\s\S]*?\n\};/)[0]} return onblur;`)(
      modal, busy, {}, () => crop, editing, () => now, 'a', async () => [{ autoCopy: on }], k => ran.push(k));
    return f().then(() => ran.join());
  };
  assert.strictEqual(await blur({}), 'autocopy');
  assert.strictEqual(await blur({ now: 'a', editing: 0 }), 'autocopy', 'a text being typed is unsaved');
  for (const o of [{ modal: true }, { busy: true }, { crop: true }, { now: 'a' }, { on: false }]) assert.strictEqual(await blur(o), '', JSON.stringify(o));
}
// An Auto copy lets Esc close without asking, but Rust still sees unsaved work (Max windows, replace-in-place keep it).
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const sent = [];
  const [run, esc] = new Function('ACTIONS', 'png', '$', 'opts', 'finishEdit', 'state', 'cropping', 'invoke', 'editing', 'gesture',
    `let busy = false, next = null, poly = null; ${src.match(/let saved = .*/)[0]} ${src.match(/let kept = [\s\S]*?\n/)[0]} ${src.match(/const report = .*/)[0]}
    ${src.match(/async function run\(key\) \{[\s\S]*?\n\}/)[0]} return [run, () => state() === saved];`)(
    { autocopy: async () => 'Copied as PNG', copy: async () => 'Copied as PNG' }, {}, () => ({}), { format: {} }, () => {},
    () => 'drawn', () => false, (c, a) => sent.push(a.d), null, false);
  await run('autocopy');
  assert.deepStrictEqual([esc(), sent.at(-1)], [true, true], 'an Auto copy made the window disposable');
  await run('copy');
  assert.deepStrictEqual(sent.at(-1), false, 'a pressed Copy left the window unsaved for Rust');
}
// Callout tail while typing: the live box (retext) keeps the edge facing the point as the text grows, and a callout right of it grows right.
{
  const { retext, bounds } = await import('./src/markup.js');
  const left = { type: 'callout', size: 10, x: 200, y: 40, text: '', em: 0, tip: [400, 50] }, off = { x: 0, y: 0 };
  const r0 = bounds(left).r;
  for (const em of [1, 5, 9]) assert.strictEqual(bounds(retext(left, 'x', em, off)).r, r0, `left-of-point callout moved its right edge at em ${em}`);
  const right = { ...left, tip: [0, 50] };
  assert.strictEqual(retext(right, 'x', 9, off).x, 200, 'right-of-point callout moved');
  assert.strictEqual(retext({ type: 'text', size: 10, x: 1, y: 2, text: '', em: 0 }, 'ab', 2, off).x, 1);
}
// Weight −/+: 1–16, step 1; holding repeats after 400 ms at ~12/s until release or leave, and a held run is one undo step.
{
  const timers = [], clear = i => { if (timers[i - 1]) timers[i - 1].dead = true; };
  const shapes = [{ type: 'rect', c: 'red', w: 4 }], log = [], store = {}, btn = { dataset: { step: 'w', d: '1' } }, props = {};
  const [down, get] = new Function('$', 'shapes', 'render', 'commit', 'localStorage', 'nextSize', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    `let gesture = false, poly = null, endPoly = () => {}, cur = 0, editing = null, tool = 'select', dpr = 1; ${STYLE_SRC} ${SRC.match(/function stepStyle\([\s\S]*?\n\}/)[0]}
    ${SRC.match(/\$\('props'\)\.onpointerdown = [\s\S]*?\n\};/)[0]} return [$('props').onpointerdown, () => ({ w: shapes[0].w, st: styleOf('rect').w })];`)(
    () => props, shapes, () => {}, () => log.push('commit'), store, nextSize,
    (f, ms) => timers.push({ f, ms }), (f, ms) => timers.push({ f, ms, every: true }), clear, clear);
  down({ button: 0, target: { closest: () => btn } });
  assert.deepStrictEqual([get().w, timers[0].ms], [5, 400], 'press: one step, repeat after 400 ms');
  timers[0].f();
  assert.ok(timers[1].every && timers[1].ms >= 80 && timers[1].ms <= 85, 'repeat is ~12 steps/s');
  for (let i = 0; i < 20; i++) timers[1].f();
  assert.deepStrictEqual(get(), { w: 16, st: 16 }, 'weight not clamped at 16');
  assert.deepStrictEqual(log, [], 'committed during the hold');
  btn.onpointerleave();
  assert.deepStrictEqual([log.length, timers[1].dead, btn.onpointerup], [1, true, null], 'leaving the button ends the run as one undo step');
  btn.dataset.d = '-1';
  for (let i = 0; i < 20; i++) { down({ button: 0, target: { closest: () => btn } }); btn.onpointerup(); }
  assert.strictEqual(get().w, 1, 'weight not clamped at 1');
}
// Color targets: Line · Fill · Text pick what the swatches color; a fill color turns a fillable shape's Fill on, none turns it off.
{
  const shapes = [{ type: 'rect', c: 'red', w: 4, fill: false }, { type: 'callout', c: 'red', w: 4, size: 20, fc: '#fff', tc: '#111', text: 'a', em: 1, x: 0, y: 0, tip: [50, 50] }];
  const t = toolbar({ shapes, cur: 0 });
  t.click({ target: 'fill' });
  t.click({ c: 'blue' });
  assert.deepStrictEqual([shapes[0].fc, shapes[0].fill, t.get().styleOf('rect').fc], ['blue', 'solid', 'blue'], 'a fill color did not turn Fill on');
  t.click({ c: 'none' });
  assert.deepStrictEqual([shapes[0].fill, shapes[0].fc], [false, 'blue'], 'none did not turn Fill off');
  t.click({ target: 'line' }); t.click({ c: 'green' });
  assert.deepStrictEqual([shapes[0].c, shapes[0].fc], ['green', 'blue']);
  const u = toolbar({ shapes, cur: 1 });
  u.click({ target: 'text' }); u.click({ c: 'blue' });
  u.click({ target: 'fill' }); u.click({ c: 'none' });
  assert.deepStrictEqual([shapes[1].tc, shapes[1].fc, shapes[1].c], ['blue', null, 'red'], 'callout targets');
  const svg = toSvg([shapes[1], { type: 'text', c: '#fff', fc: '#000', size: 10, em: 2, x: 0, y: 0, text: 'ab' }, { type: 'rect', c: 'red', w: 2, fill: true, l: 0, t: 0, r: 9, b: 9 }], { x: 0, y: 0, w: 99, h: 99 });
  assert.match(svg, /fill="none" stroke="red"[^>]*\/><text[^>]*fill="blue"/, 'callout box none / text color');
  assert.match(svg, /<path d="M-1\.5 0H21\.5V12\.5H-1\.5Z" fill="#000"\/><text[^>]*fill="#fff"/, 'text background');
  assert.match(svg, /fill="red" stroke="red"/, 'a fill with no color of its own follows the line');
  const v = toolbar({ tool: 'pen' }); // no targets: swatches color the line whatever was picked
  v.click({ target: 'fill' }); v.click({ c: 'blue' });
  assert.strictEqual(v.get().styleOf('pen').c, 'blue');
}
// Polygon: clicks add points; a double-click, Enter or the first point closes; Backspace drops a point; Esc cancels; Shift snaps.
{
  const block = SRC.match(/let poly = null, polyAt = 0;[\s\S]*?\n\}\);/)[0];
  const make = () => {
    const shapes = [], log = [], stage = { addEventListener: (t, f) => { stage.move = f; } };
    const api = new Function('shapes', 'stage', 'shot', 'snap', 'render', 'commit', 'localStorage', 'atInk',
      `let cur = null, gesture = false, dpr = 1, tool = 'poly'; ${STYLE_SRC} ${block}
      return { polyClick, endPoly, cancelPoly, dropPoint, get: () => ({ poly, cur }) };`)(
      shapes, stage, { naturalWidth: 100, clientWidth: 100 }, snap, () => {}, () => log.push('commit'), {}, e => [e.x, e.y]);
    return { shapes, log, stage, ...api, at: (x, y, t, o = {}) => api.polyClick({ x, y, timeStamp: t, ...o }) };
  };
  let p = make();
  p.at(0, 0, 0); p.at(100, 0, 1000); p.at(100, 100, 2000);
  p.stage.move({ x: 50, y: 150 });
  assert.deepStrictEqual(p.shapes[0].pts.at(-1), [50, 150], 'the last point does not follow the pointer');
  assert.match(toSvg(p.shapes, { x: 0, y: 0, w: 9, h: 9 }), /d="M0 0L100 0L100 100L50 150" fill="none"/, 'an open polygon is drawn unclosed, unfilled');
  p.at(3, 2, 3000); // the first point closes it
  assert.deepStrictEqual([p.shapes[0].pts, p.shapes[0].open, p.get(), p.log], [[[0, 0], [100, 0], [100, 100]], undefined, { poly: null, cur: 0 }, ['commit']]);
  p.shapes[0].fill = true;
  assert.match(toSvg(p.shapes, { x: 0, y: 0, w: 9, h: 9 }), /d="M0 0L100 0L100 100Z" fill="#e53935"/, 'closed polygon');
  p = make(); // double-click closes without a doubled point
  p.at(0, 0, 0); p.at(100, 0, 1000); p.at(100, 100, 2000); p.at(101, 100, 2200);
  assert.strictEqual(p.shapes[0].pts.length, 3, 'double-click left a duplicate point');
  p = make(); // Backspace drops the last point; Shift snaps; fewer than 3 points is nothing
  p.at(0, 0, 0); p.at(100, 10, 1000, { shiftKey: true });
  assert.deepStrictEqual(p.shapes[0].pts[1].map(Math.round), [100, 0], 'Shift did not snap the edge');
  p.dropPoint();
  assert.strictEqual(p.shapes[0].pts.length, 2);
  p.endPoly();
  assert.deepStrictEqual([p.shapes.length, p.log], [0, []], 'a 1-point polygon was kept');
  p = make(); p.at(0, 0, 0); p.at(50, 50, 1000); p.cancelPoly();
  assert.deepStrictEqual([p.shapes.length, p.get().poly], [0, null], 'Esc did not cancel');
  // Keys while drawing: Esc cancels, Enter closes, Backspace drops a point (not the selected shape).
  const done = [];
  const k = new Function('run', 'finishEdit', 'cropping', 'remove', 'edit', 'go', 'render', 'stage', 'closeEditor', 'cancelPoly', 'endPoly', 'dropPoint',
    `let gesture = false, poly = 0, cur = null, tool = 'poly', onkeydown; ${SRC.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    () => {}, () => {}, () => false, () => done.push('remove'), {}, () => {}, () => {}, { dataset: {} }, () => done.push('close'), () => done.push('cancel'), () => done.push('end'), () => done.push('drop'));
  for (const key of ['Escape', 'Enter', 'Backspace']) k({ key, target: { tagName: 'BODY' }, preventDefault() {} });
  assert.deepStrictEqual(done, ['cancel', 'end', 'drop']);
}
// Fill patterns: the menu picks one (and makes it the last); Fill's button toggles the last; a fill color keeps the pattern;
// density scales the tile; each pattern is a <pattern> the shape's fill points at, in the fill color.
{
  const { PATTERNS } = await import('./src/markup.js');
  const shapes = [{ type: 'rect', c: 'red', w: 4, dpr: 1, fill: false, l: 0, t: 0, r: 50, b: 50 }], t = toolbar({ shapes, cur: 0 });
  t.click({ fk: 'cross' });
  assert.deepStrictEqual([shapes[0].fill, t.get().styleOf('rect').last, 'last' in shapes[0]], ['cross', 'cross', false]);
  t.click({ fill: '' }); t.click({ fill: '' });
  assert.strictEqual(shapes[0].fill, 'cross', "Fill's button did not bring the last pattern back");
  t.click({ target: 'fill' }); t.click({ c: 'blue' });
  assert.deepStrictEqual([shapes[0].fill, shapes[0].fc], ['cross', 'blue'], 'a fill color replaced the pattern');
  t.click({ fk: 'none' });
  assert.strictEqual(shapes[0].fill, false);
  assert.strictEqual(Object.keys(PATTERNS).length, 12);
  for (const k of Object.keys(PATTERNS)) {
    const svg = toSvg([{ ...shapes[0], fill: k, fc: 'blue', dn: 2 }], { x: 0, y: 0, w: 9, h: 9 }, 8);
    assert.match(svg, /<pattern id="jm0" [^>]*scale\(4\)" fill="blue" color="blue">/, `${k}: tile not 8 px / density 2, or not in the fill color`);
    assert.match(svg, /<g data-i="0"><defs>.*<\/defs><path [^>]*fill="url\(#jm0\)"/, `${k}: shape does not use its pattern`);
    assert.match(svg, /<g opacity="0"><path [^>]*fill="blue"/, `${k}: hit outline not solid`);
  }
  assert.match(toSvg([{ ...shapes[0], fill: true, fc: undefined }], { x: 0, y: 0, w: 9, h: 9 }), /fill="red"/, 'an old boolean fill is solid');
}
// See-through: the whole shape at 40% as one group (a stroke over its own fill doesn't double); not on text, callout or hl.
{
  const shapes = [{ type: 'rect', c: 'red', w: 4, dpr: 1, fill: 'solid', l: 0, t: 0, r: 50, b: 50 }], t = toolbar({ shapes, cur: 0 });
  t.click({ see: '' });
  assert.deepStrictEqual([shapes[0].see, t.get().styleOf('rect').see, t.get().styleOf('ellipse').see], [true, true, false]);
  assert.match(toSvg(shapes, { x: 0, y: 0, w: 9, h: 9 }, 8), /<g data-i="0"><g opacity="0.4"><path [^>]*fill="red"[^>]*\/><\/g><g opacity="0">/, 'not one 40% group, or the hit outline went see-through');
  const kinds = new Function(`${SRC.match(/const KINDS = .*/)[0]} return KINDS;`)();
  assert.deepStrictEqual(Object.keys(kinds).filter(k => kinds[k].includes('o')), ['pen', 'line', 'arrow', 'rect', 'ellipse', 'cloud', 'poly']);
}

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
// Markup geometry and serialization.
const { dragEdges, bounds, move, resize, toSvg, snap, nextSize } = await import('./src/markup.js');
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
// Fill with a line selected toggles the default fill both ways (a line has no fill of its own).
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const style = { pen: { fill: false }, hl: {} }, shapes = [{ type: 'line', pts: [] }];
  const tools = {};
  new Function('$', 'shapes', 'style', 'styleOf', 'commit', 'render', `let gesture = false, cur = 0, editing = null, tool = 'select', dpr = 1; ${src.match(/const filled = .*/)?.[0]}; ${src.match(/\$\('tools'\)\.onclick = [\s\S]*?\n};/)[0]}`)(
    () => tools, shapes, style, () => style.pen, () => {}, () => {});
  const click = () => tools.onclick({ target: { closest: () => ({ dataset: { fill: '' } }) } });
  click();
  assert.strictEqual(style.pen.fill, true);
  click();
  assert.strictEqual(style.pen.fill, false, 'second Fill click turns the default fill off');
}
// Delete/Backspace on the Format or Quality radios must not delete the selected shape.
globalThis.document = { querySelector: () => null }; // no Save menu open
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  let removed = 0;
  const f = new Function('run', 'finishEdit', 'cropping', 'marking', 'remove', 'edit', 'go', 'render', 'stage', `let gesture = false, cur = 0, tool = 'select', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    () => {}, () => {}, () => false, () => true, () => { removed++; }, {}, () => {}, () => {}, { dataset: {} });
  f({ key: 'Delete', target: { tagName: 'INPUT' } });
  f({ key: 'Backspace', target: { tagName: 'INPUT' } });
  assert.strictEqual(removed, 0, 'Delete on a radio removed the shape');
  f({ key: 'Delete', target: { tagName: 'BODY' } });
  assert.strictEqual(removed, 1);
  // Ctrl+P on a non-Latin layout (e.key 'з', e.code 'KeyP') must still be intercepted.
  const ran = [];
  const g = new Function('run', 'finishEdit', 'cropping', 'marking', 'remove', 'edit', 'go', 'render', 'stage', `let gesture = false, cur = 0, tool = 'select', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    a => ran.push(a), () => {}, () => false, () => true, () => {}, {}, () => {}, () => {}, { dataset: {} });
  let prevented = 0;
  g({ ctrlKey: true, key: 'з', code: 'KeyP', target: { tagName: 'BODY' }, preventDefault: () => prevented++ });
  assert.ok(prevented === 1 && ran[0] === 'print', 'Ctrl+P on a non-Latin layout was not intercepted');
  g({ ctrlKey: true, key: 'l', code: 'KeyP', target: { tagName: 'BODY' }, preventDefault: () => prevented++ }); // Dvorak Ctrl+L
  assert.ok(prevented === 1 && ran.length === 1, 'Ctrl+L on Dvorak was taken for print');
  const steps = [];
  const h = new Function('run', 'finishEdit', 'cropping', 'marking', 'remove', 'edit', 'go', 'render', 'stage', `let gesture = false, cur = 0, tool = 'select', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    () => {}, () => {}, () => false, () => false, () => {}, {}, d => steps.push(d), () => {}, { dataset: {} });
  h({ metaKey: true, key: 'z', target: { tagName: 'BODY' }, preventDefault: () => {} });
  h({ metaKey: true, shiftKey: true, key: 'z', target: { tagName: 'BODY' }, preventDefault: () => {} });
  assert.deepStrictEqual(steps, [-1, 1], 'Cmd+Z / Cmd+Shift+Z did not undo / redo');
  // Esc during IME composition belongs to the IME; it must not end the edit.
  let fin = 0;
  const edit = {};
  const m = new Function('run', 'finishEdit', 'cropping', 'marking', 'remove', 'edit', 'go', 'render', 'stage', `let gesture = false, cur = 0, tool = 'select', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    () => {}, () => fin++, () => false, () => true, () => {}, edit, () => {}, () => {}, { dataset: {} });
  m({ key: 'Escape', isComposing: true, target: edit });
  assert.strictEqual(fin, 0, 'Esc during IME composition ended the edit');
  m({ key: 'Escape', target: edit });
  assert.strictEqual(fin, 1);
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
  new Function('ResizeObserver', 'document', 'header', 'applyZoom', src.match(/new ResizeObserver\(.*/)[0])(
    class { constructor(f) { ro = f; } observe() {} }, { body: { style: {} } }, { offsetHeight: 120 }, () => zoomed++);
  ro();
  assert.equal(zoomed, 1, 'header resize did not re-run applyZoom');
}
// Zooming the browser keeps the picked width and text size in screen pixels, and the pressed-state match exact.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const style = { pen: { w: 4, size: 20 }, hl: { w: 8 } }, g = { devicePixelRatio: 1 };
  const [sync, get] = new Function('style', 'g', `let dpr = 1; ${src.match(/function syncDpr\(\) \{[\s\S]*?\n\}/)[0].replaceAll('devicePixelRatio', 'g.devicePixelRatio')} return [syncDpr, () => dpr];`)(style, g);
  for (const r of [1.1, 1.25, 2.5, 0.9, 1]) {
    g.devicePixelRatio = r;
    sync();
    assert.equal(get(), r);
    assert.ok(style.pen.w === 4 * r && style.pen.size === 20 * r && style.hl.w === 8 * r, `at ${r}: ${JSON.stringify(style)}`);
  }
}
// Crop swap: from Apply crop until the new image has loaded, a gesture would mix the old image's geometry with the new offset.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8'), m = re => src.match(re)[0];
  let release, downs = 0;
  const stage = { classList: { contains: () => false, remove() {} }, setPointerCapture() {} }, shot = {}, el = { style: {}, setAttribute() {} };
  const t = new Function('$', 'stage', 'shot', 'sel', 'edit', 'document', 'URL', 'OffscreenCanvas', 'createImageBitmap', 'cropping', 'marking', 'cropDown', 'markDown', 'applyZoom', 'show',
    `let gesture = false, editing = null, swapping = false, png = 'old', off = { x: 0, y: 0 }, original, box = { l: 2, t: 2, r: 6, b: 6 }, devicePixelRatio = 1;
    ${m(/function setShot\([\s\S]*?\n\}/)} ${m(/function endCrop\([\s\S]*?\n\}/)} ${m(/async function applyCrop\([\s\S]*?\n\}/)}
    ${m(/stage\.onpointerdown = [\s\S]*?\n\};/)} ${m(/stage\.onpointercancel = [\s\S]*?\n\};/)} ${m(/shot\.onload = [\s\S]*?\n\};/)} return applyCrop;`)(
    () => el, stage, shot, el, {}, { activeElement: { blur() {} } }, { createObjectURL: () => 'blob:new', revokeObjectURL() {} },
    class { getContext() { return { drawImage() {} }; } convertToBlob() { return 'new'; } }, () => new Promise(r => { release = r; }),
    () => false, () => true, () => downs++, () => downs++, () => {}, () => {});
  const down = () => stage.onpointerdown({ button: 0, pointerId: 1, target: {}, preventDefault() {} }) || stage.onlostpointercapture({});
  const applying = t();
  down();
  release({});
  await applying;
  down();
  assert.strictEqual(downs, 0, 'gesture started while the cropped image was swapping in');
  shot.onload();
  down();
  assert.strictEqual(downs, 1);
}
// Toolbar presses while a new text is open: the editor keeps focus (so blur can't delete the empty text first), a swatch styles the pending text, Undo only cancels it.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const style = { pen: { c: 'red', size: 20 }, text: { c: 'red' } }, shapes = [{ type: 'text', c: 'red', size: 20, text: '' }], tools = {}, log = [];
  new Function('$', 'shapes', 'style', 'styleOf', 'commit', 'render', 'finishEdit', 'go', 'edit', 'log', `let gesture = false, cur = 0, editing = 0, tool = 'text', dpr = 1; const stage = { dataset: {} };
    ${src.match(/const filled = .*/)?.[0]}; ${src.match(/\$\('tools'\)\.onmousedown = .*/)?.[0]}; ${src.match(/\$\('tools'\)\.onclick = [\s\S]*?\n};/)[0]}`)(
    () => tools, shapes, style, () => style.text, () => log.push('commit'), () => {}, () => log.push('finish'), () => log.push('go'), { value: '' }, log);
  let prevented = 0;
  tools.onmousedown({ preventDefault: () => prevented++ });
  assert.strictEqual(prevented, 1, 'toolbar press moved focus out of the editor');
  tools.onclick({ target: { closest: () => ({ dataset: { c: 'blue' } }) } });
  assert.strictEqual(shapes[0].c, 'blue', 'swatch did not style the pending text');
  assert.ok(!log.includes('commit'), 'swatch committed an empty text');
  log.length = 0;
  tools.onclick({ target: { closest: () => ({ dataset: { cmd: 'undo' } }) } });
  assert.ok(!log.includes('go'), 'Undo on an empty new text also undid the previous commit');
}
// Print: if print() returns without firing afterprint (policy-blocked, throttled), .burned must not linger for menu Print.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const cls = new Set(), p = { decode: async () => {}, removeAttribute() {} };
  const act = new Function('$', 'encode', 'document', 'URL', 'addEventListener', 'print',
    `return {${src.match(/async print\(\) \{[\s\S]*?\n  \},/)[0]}}`)(
    () => p, async () => ({}), { body: { classList: { add: c => cls.add(c), remove: c => cls.delete(c) } } },
    { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, () => {}, () => {});
  await act.print();
  assert.ok(!cls.has('burned'), 'body.burned left set after a print() that never fired afterprint');
}
// Save: a failed write is reported, a cancelled dialog is silent; only a save that went through counts as saved (Esc won't ask).
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const els = {}, $ = id => (els[id] ??= { value: 'png', textContent: '' }), opts = { format: { value: 'png' } };
  let result;
  const [run, saved] = new Function('$', 'encode', 'invoke', 'png', 'state', 'opts',
    `let saved = 'blank'; const ACTIONS = {${src.match(/async save\(fmt\) \{[\s\S]*?\n  \},/)[0]}}; ${src.match(/let busy = false;[\s\S]*?\n\}/)[0]}; return [run, () => saved];`)(
    $, async () => new Blob(['x']), async (cmd, body, o) => { assert.deepStrictEqual([cmd, o.headers.ext], ['save', 'png']); return result(); }, {}, () => 'drawn', opts);
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
// Esc steps back to Select, then closes; closing with unsaved markup asks first.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const log = [], stage = { dataset: {} };
  const key = (cur, tool, marking = true) => new Function('run', 'finishEdit', 'cropping', 'marking', 'remove', 'edit', 'go', 'render', 'stage', 'closeEditor',
    `let gesture = false, cur = ${cur}, tool = '${tool}', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
    a => log.push(a), () => {}, () => false, () => marking, () => {}, {}, () => {}, () => log.push('render'), stage, () => log.push('close'))({ key: 'Escape', target: {} });
  key(0, 'select'); key('null', 'arrow');
  assert.deepStrictEqual(log, ['render', 'render'], 'Esc closed with a shape selected or a drawing tool picked');
  key('null', 'select');
  assert.deepStrictEqual(log.slice(2), ['close'], 'Esc with nothing to step back from did not close');
  globalThis.document = { querySelector: () => ({}) }; // Save menu open: Esc is the menu's
  key('null', 'select');
  assert.strictEqual(log.length, 3, 'Esc with the Save menu open stepped back or closed');
  globalThis.document = { querySelector: () => null };
  const ask = new Function('state', 'saved', 'confirm', 'invoke', `${src.match(/const closeEditor = .*/)[0]} return closeEditor;`);
  const closed = [];
  ask(() => 'a', 'a', () => assert.fail('asked with nothing unsaved'), c => closed.push(c))();
  ask(() => 'b', 'a', () => false, c => closed.push(c))();
  assert.deepStrictEqual(closed, ['close'], 'closed despite a declined confirm');
}
// Editing text in a light swatch (White/Yellow) must not sit on #edit's near-white CSS background.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8');
  const line = src.match(/Object\.assign\(edit\.style, .*/)[0];
  const run = s => { const edit = { style: {} }; new Function('edit', 's', 'k', 'p', 'W', 'off', 'shot', 'LH', line)(edit, s, 1, 0, 100, { x: 0, y: 0 }, { naturalHeight: 100 }, 1.2); return edit.style; };
  assert.strictEqual(run({ x: 0, y: 0, size: 16, c: '#ffffff' }).background, '#000c', 'white text gets a dark edit background');
  assert.strictEqual(run({ x: 0, y: 0, size: 16, c: '#fdd835' }).background, '#000c', 'yellow text gets a dark edit background');
  assert.notStrictEqual(run({ x: 0, y: 0, size: 16, c: '#e53935' }).background, '#000c', 'red keeps the default light background');
}
// A huge paste (150k lines) or pen stroke must not overflow the spread-args limit.
{
  const big = Array.from({ length: 150000 }, (_, i) => [i, 1 - i]);
  assert.deepStrictEqual(bounds({ pts: big }), { l: 0, t: -149998, r: 149999, b: 1 }, 'bounds of a 150k-point stroke');
  const line = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8').match(/if \(text\) shapes\[i\] = .*/)[0];
  const shapes = [{}], measure = { measureText: l => ({ width: l.length * 10 }) };
  new Function('shapes', 'i', 'text', 'measure', line)(shapes, 0, 'ab\n' + '\n'.repeat(150000), measure);
  assert.strictEqual(shapes[0].em, 0.2, 'finishEdit measures a 150k-line text');
}
// A callout dragged up-left of its point grows away from the point, not back over it.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8').match(/function finishEdit[\s\S]*?\n}/)[0];
  const shapes = [{ type: 'callout', size: 10, x: 60, y: 60, text: '', em: 0, tip: [100, 100] }], measure = { measureText: l => ({ width: l.length * 60 }) };
  new Function('shapes', 'measure', 'bounds', 'commit', 'edit', `let editing = 0, cur = 0; ${src}; finishEdit();`)(shapes, measure, bounds, () => {}, { value: 'abcdefgh\nx' });
  const b = bounds(shapes[0]);
  assert.ok(b.r <= 100 && b.b <= 100, 'callout box covers its own point');
}
// Editing a text whose top is under the fixed header scrolls it clear of the header.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8').match(/function startEdit[\s\S]*?\n}/)[0];
  let dy = 0;
  const edit = { focus() {}, getBoundingClientRect: () => ({ top: 30 }) };
  new Function('shapes', 'edit', 'render', 'header', 'scrollBy', `let editing, cur; ${src}; startEdit(0);`)([{ text: 'a' }], edit, () => {}, { offsetHeight: 50 }, (x, y) => { dy += y; });
  assert.strictEqual(dy, -20, 'startEdit scrolls the editor out from under the header');
}
// Single-letter tool keys click the button whose data-key matches; other keys and Ctrl+letter don't.
{
  const src = (await import('node:fs')).readFileSync('./src/editor.js', 'utf8'), html = (await import('node:fs')).readFileSync('./src/index.html', 'utf8');
  const clicked = [];
  globalThis.document = { querySelector: q => q === ':popover-open' ? null : (clicked.push(q), { click() {} }) };
  const k = new Function('run', 'finishEdit', 'cropping', 'remove', 'edit', 'go', 'render', 'stage', 'closeEditor',
    `let gesture = false, cur = null, tool = 'select', onkeydown; ${src.match(/onkeydown = e => \{[\s\S]*?\n\};/)[0]} return onkeydown;`)(
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
console.log('ok');

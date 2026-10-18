// Tests for src/pdfout.js (image-PDF container writer). No need to run unless
// you changed pdfout.js. Prereq: `npm install`. Run: `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImagePdf, textLayerStream } from '../src/pdfout.js';

// A JPEG's actual content is irrelevant to the container structure.
const fakeJpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0xff, 0xd9]);

test('buildImagePdf writes a structurally sound single-page PDF', () => {
  const bytes = buildImagePdf([{ w: 612, h: 792, pw: 1224, ph: 1584, jpeg: fakeJpeg() }]);
  const text = Buffer.from(bytes).toString('latin1');

  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /\/Count 1/);
  assert.match(text, /\/MediaBox \[0 0 612 792\]/);
  assert.match(text, /\/Width 1224 \/Height 1584/);
  assert.match(text, /\/Filter \/DCTDecode/);
  assert.match(text, /%%EOF\n$/);

  // startxref must point at the xref table.
  const startxref = Number(text.match(/startxref\n(\d+)\n/)[1]);
  assert.equal(text.slice(startxref, startxref + 4), 'xref');

  // Every xref entry must point at the object it claims to.
  const entries = [...text.matchAll(/^(\d{10}) 00000 n /gm)].map((m) => Number(m[1]));
  entries.forEach((off, i) => {
    assert.equal(text.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `object ${i + 1} offset`);
  });
  assert.equal(entries.length, 5); // catalog, pages, page, contents, image
});

test('buildImagePdf handles multiple pages and fractional sizes', () => {
  const bytes = buildImagePdf([
    { w: 595.28, h: 841.89, pw: 10, ph: 10, jpeg: fakeJpeg() },
    { w: 612, h: 792, pw: 10, ph: 10, jpeg: fakeJpeg() },
  ]);
  const text = Buffer.from(bytes).toString('latin1');
  assert.match(text, /\/Count 2/);
  assert.match(text, /\/MediaBox \[0 0 595\.28 841\.89\]/);
  assert.match(text, /\/Kids \[3 0 R 6 0 R\]/);
});

test('an invisible text layer reads back through pdf.js at the word positions', async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const words = [
    ['Quito', 72, 700, 30, 10],
    ['0°13′07″S,', 106, 700, 52, 10],
    ['(a)\\b', 72, 680, 25, 10],
  ];
  const bytes = buildImagePdf([
    { w: 612, h: 792, pw: 10, ph: 10, jpeg: fakeJpeg(), words },
    { w: 612, h: 792, pw: 10, ph: 10, jpeg: fakeJpeg() }, // no text layer
  ]);
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const items = (await (await doc.getPage(1)).getTextContent()).items.filter((it) => it.str);
  // Primes come out as plain ticks; brackets and backslashes survive escaping.
  // pdf.js joins the two words of the first line into one item, which it only
  // does when the first one's stretched width ends where the gap begins.
  assert.deepEqual(items.map((it) => it.str), [`Quito 0°13'07"S,`, '(a)\\b']);
  const expect = [[72, 700, 106 + 52 - 72], [72, 680, 25]];
  items.forEach((it, i) => {
    const [x, y, w] = expect[i];
    assert.ok(Math.abs(it.transform[4] - x) < 0.01, `x of ${it.str}`);
    assert.ok(Math.abs(it.transform[5] - y) < 0.01, `y of ${it.str}`);
    assert.ok(Math.abs(it.width - w) < 0.5, `width of ${it.str}: ${it.width}`);
  });
  assert.equal((await (await doc.getPage(2)).getTextContent()).items.length, 0);
});

test('text layers are invisible (render mode 3) and share one font object', () => {
  const stream = Buffer.from(textLayerStream([['a', 0, 0, 6, 10]])).toString('latin1');
  assert.match(stream, /^BT\n3 Tr\n/);
  const text = Buffer.from(buildImagePdf([
    { w: 612, h: 792, pw: 10, ph: 10, jpeg: fakeJpeg(), words: [['a', 1, 1, 6, 10]] },
    { w: 612, h: 792, pw: 10, ph: 10, jpeg: fakeJpeg(), words: [['b', 1, 1, 6, 10]] },
  ])).toString('latin1');
  assert.equal(text.match(/\/BaseFont \/Courier/g).length, 1);
  assert.equal(text.match(/\/F1 9 0 R/g).length, 2);
});

test('buildImagePdf rejects empty input', () => {
  assert.throws(() => buildImagePdf([]), /No pages/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImagePdf } from '../src/pdfout.js';

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

test('buildImagePdf rejects empty input', () => {
  assert.throws(() => buildImagePdf([]), /No pages/);
});

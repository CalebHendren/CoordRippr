// Tests for src/ocr.js (OCR word boxes -> page text, misread repairs). Pure,
// except the two demo checks, which need pdfjs-dist (`npm install`).
// Run: `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  hasTextLayer, wantsOcr, normalizeOcrWords, wordsFromOcr, ocrTextContent, bodyStart,
  MIN_TEXT_LAYER_CHARS,
} from '../src/ocr.js';
import { buildPageText, rectsForRange } from '../src/pdftext.js';
import { extractCoordinates, extractCrossPage } from '../src/coords.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const near = (a, b, eps = 1e-4) => (a == null || b == null ? a === b : Math.abs(a - b) < eps);

// --- which pages get OCR -----------------------------------------------------

test('a page needs a few dozen characters to count as having a text layer', () => {
  const tc = (s) => ({ items: [{ str: s }] });
  assert.equal(hasTextLayer({ items: [] }), false);
  assert.equal(hasTextLayer(tc('  3  ')), false); // a stray page number
  assert.equal(hasTextLayer(tc('x'.repeat(MIN_TEXT_LAYER_CHARS - 1))), false);
  assert.equal(hasTextLayer(tc('x'.repeat(MIN_TEXT_LAYER_CHARS))), true);
});

test('per-PDF mode and the app-wide switch decide OCR', () => {
  assert.equal(wantsOcr(true, 'auto', true), true);
  assert.equal(wantsOcr(false, 'auto', true), false);
  assert.equal(wantsOcr(true, 'auto', false), false);
  assert.equal(wantsOcr(true, 'off', true), false);
  assert.equal(wantsOcr(false, 'force', true), true);
  assert.equal(wantsOcr(false, 'force', false), true); // asked for by name
});

// --- misread repairs -------------------------------------------------------

const fix = (line) => normalizeOcrWords(line.split(' ')).join(' ');

test('marks after the degree sign are re-typed by position', () => {
  assert.equal(fix('0°40°27°S'), `0°40'27"S`);
  assert.equal(fix('(4°36"35"N'), `(4°36'35"N`);
  assert.equal(fix('71°58°W)'), `71°58'W)`);
  assert.equal(fix('2°53\'49,6°S'), `2°53'49,6"S`);
  assert.equal(fix('79°00°15.2"W'), `79°00'15.2"W`);
  assert.equal(fix("22°54'11''S"), `22°54'11"S`);
  // ...across a word break when the prime was lost: 76°23′52″W
  assert.equal(fix('76°23 52°W'), `76°23 52"W`);
  // ...and across a line-wrapped coordinate
  assert.equal(fix('77° 48\'29"W)'), `77° 48'29"W)`);
});

test('minutes and seconds glued together get their primes back', () => {
  assert.equal(fix('0°1503" S'), `0°15'03" S`);
  assert.equal(fix('(S0°0008"'), `(S0°00'08"`);
});

test('a degree sign read as a zero is restored before a minute mark', () => {
  assert.equal(fix("2010'S, 79053'W,"), `2°10'S, 79°53'W,`);
});

test('letters read for digits, and specks, next to coordinate digits', () => {
  assert.equal(fix("IDeg 29'S"), `1Deg 29'S`);
  assert.equal(fix("77°48'S0'W"), `77°48'50"W`);
  assert.equal(fix('.0°13\'07"S,'), `0°13'07"S,`);
  assert.equal(fix("0°40'27\"S76°23"), `0°40'27"S 76°23`);
  assert.equal(fix("79°12'0 2060"), `79°12'O 2060`);
  assert.equal(fix('0°15\'03" S$ /76°10\'40"'), `0°15'03" S /76°10'40"`);
});

test('prose, years, page ranges and plain numbers pass through untouched', () => {
  for (const line of [
    'Journal of Placeholder Entomology 14(3): 201-202 (2026)',
    'taken in 1898, between 1200 and 2800 m, 100 ft.,',
    "the 2010's and 1990's were wet; rotated 25-30 degrees",
    'Lima (12.0464, -77.0428) at least 14 specimens',
    'Isolated I and l letters, Il|, and SO on',
    '0.4651° N, 77.8912° W and 9°44.287 N 83°46.875 W',
  ]) {
    assert.equal(fix(line), line);
  }
});

// The repairs must never change a correctly typeset coordinate: run every
// line of the real demo article through them as if it were OCR output.
test('repairs leave the demo article\'s detections exactly as they were', async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(path.join(__dirname, '..', 'docs', 'demo.pdf')));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  for (let p = 1; p <= doc.numPages; p++) {
    const text = buildPageText(await (await doc.getPage(p)).getTextContent()).text;
    const fixed = text.split('\n').map((line) => normalizeOcrWords(line.split(' ')).join(' ')).join('\n');
    const dd = (t) => extractCoordinates(t, 7).map((x) => [x.lat?.dd ?? null, x.lon?.dd ?? null]);
    assert.deepEqual(dd(fixed), dd(text), `page ${p}`);
  }
});

// --- word boxes -> text ----------------------------------------------------

// A tesseract.js-shaped line: words with image-pixel boxes on a flat baseline.
function line(y, words, { conf = 90 } = {}) {
  let x = 100;
  const ws = words.map((w) => {
    const text = Array.isArray(w) ? w[0] : w;
    const c = Array.isArray(w) ? w[1] : conf;
    const box = { x0: x, y0: y - 30, x1: x + text.length * 20, y1: y + 8 };
    x = box.x1 + 20;
    return { text, confidence: c, bbox: box };
  });
  return {
    words: ws,
    bbox: { x0: 100, y0: y - 30, x1: x, y1: y + 8 },
    baseline: { x0: 100, y0: y, x1: x, y1: y },
    rowAttributes: { rowHeight: 40, descenders: 8, ascenders: 10 },
  };
}
const data = (...lines) => ({ blocks: [{ paragraphs: [{ lines }] }] });
const PAGE = { scale: 2, pageW: 612, pageH: 792 };

test('words become one item each, lines end in a line break', () => {
  const words = wordsFromOcr(data(line(400, ['Near', 'Quito,']), line(450, ['0°13\'07"S'])), PAGE);
  const { text, spans } = buildPageText(ocrTextContent(words));
  assert.equal(text, 'Near Quito,\n0°13\'07"S\n');
  assert.equal(spans.length, 3);
});

test('tight word gaps still read as spaces', () => {
  const l = line(400, ['0°40\'27"S', '76°23\'52"W']);
  l.words[1].bbox.x0 = l.words[0].bbox.x1 + 1; // boxes almost touching
  const { text } = buildPageText(ocrTextContent(wordsFromOcr(data(l), PAGE)));
  assert.equal(text, '0°40\'27"S 76°23\'52"W\n');
});

test('low-confidence letters are dropped, low-confidence numbers kept', () => {
  const words = wordsFromOcr(data(line(400, [['speck', 5], ['(4°36"35"N', 8], ['Bogota', 95]])), PAGE);
  assert.deepEqual(words.map((w) => w[0]), ['(4°36\'35"N', 'Bogota']);
});

test('a highlight covers the word box on the page', () => {
  const words = wordsFromOcr(data(line(400, ['at', '0°13\'S'])), PAGE);
  const { text, spans } = buildPageText(ocrTextContent(words));
  const start = text.indexOf('0°');
  const [[x1, y1, x2, y2]] = rectsForRange(spans, start, start + 6);
  // Second word: pixels 160..280 at scale 2 -> points 80..140. Line box spans
  // pixels 370..408 (baseline 400, 40 tall with 8 of descender): y up.
  assert.ok(near(x1, 80, 0.01) && near(x2, 140, 0.01), `x ${x1}..${x2}`);
  assert.ok(near(y1, 792 - 408 / 2, 0.05) && near(y2, 792 - 368 / 2, 0.05), `y ${y1}..${y2}`);
});

test('boxes on a deskewed page are turned back onto the scan', () => {
  const at = (angle) => wordsFromOcr(data(line(400, ['x'])), { ...PAGE, angle })[0];
  const flat = at(0);
  const tilted = at(0.01);
  // The word is left of and above the page centre; a small rotation moves it
  // by about angle × distance from the centre, never more.
  const dist = Math.hypot(612 / 2 - flat[1], 792 / 2 - flat[2]);
  const moved = Math.hypot(tilted[1] - flat[1], tilted[2] - flat[2]);
  assert.ok(moved > 0 && moved <= dist * 0.0101, `moved ${moved}`);
});

test('running heads move to the front, and bodyStart skips them', () => {
  // Page is 1584 px tall at scale 2: a line ending above 8% (127 px) is a head.
  const words = wordsFromOcr(data(line(400, ['Body', 'text']), line(80, ['Journal', '14(3)'])), PAGE);
  const { text, spans } = buildPageText(ocrTextContent(words));
  assert.equal(text, 'Journal 14(3)\nBody text\n');
  assert.equal(bodyStart(spans), text.indexOf('Body'));
  assert.equal(bodyStart(buildPageText({ items: [] }).spans), 0);
});

// --- the scanned demo article ----------------------------------------------

// Real OCR of docs/demo-scanned.pdf as the app produced it (the word lists in
// fixtures/demo-scanned-ocr.json). Regenerate the fixture after changing the
// engine settings: load the scan in the app and copy the pages' `ocr` arrays
// out of the project snapshot.
test('scanned demo: most of the article\'s coordinates come through OCR', async () => {
  const fixture = JSON.parse(await fs.readFile(path.join(__dirname, 'fixtures', 'demo-scanned-ocr.json'), 'utf8'));
  const pages = fixture.pages.map((words) => buildPageText(ocrTextContent(words)));
  const found = pages.flatMap(({ text }, i) =>
    extractCoordinates(text, 7).map((p) => [i + 1, p.lat?.dd ?? null, p.lon?.dd ?? null]));
  // A sample of the forms the clean article has (test/demo-pdf.test.js),
  // including ones OCR garbles and the repairs above put right.
  for (const [page, lat, lon] of [
    [1, 4.60972, -74.08167], // ′ ″ read as " "
    [1, -13.51667, -71.96667], // ´ read as °
    [1, -2.16667, -79.88333], // o for ° read as 0
    [1, -0.00222, -78.45583], // primes dropped
    [1, -0.9, -77.80806], // wrapped across lines
    [1, -34.6, -58.36667],
    [2, -0.67417, -76.39778], // ″ read as °, hemisphere glued on
    [2, -1.48333, -78], // 1Deg read as IDeg
    [2, -3.98333, -79.2], // O for West read as 0
    [2, -2.89711, -79.00422],
  ]) {
    assert.ok(found.some(([p, a, b]) => p === page && near(a, lat, 1e-3) && near(b, lon, 1e-3)),
      `p${page} ${lat}, ${lon} not found`);
  }
  assert.ok(found.length >= 25, `only ${found.length} rows`);
  const cross = extractCrossPage(pages[0].text, pages[1].text, 7, undefined, bodyStart(pages[1].spans));
  assert.equal(cross.length, 1);
  assert.ok(near(cross[0].lat.dd, -0.05, 1e-3) && near(cross[0].lon.dd, -78.76667, 1e-3));
});

// Integration test: real pdf.js text extraction over the sample PDF, checking
// the full pipeline (src/pdftext.js + src/coords.js). No need to run unless you
// changed pdftext.js, coords.js, or the sample fixture.
// Prereq: `npm install` — this test imports pdfjs-dist and ERRORS without it
// (needs network to download). Run: `node --test test/pdf-extract.test.js`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildPageText, rectsForRange } from '../src/pdftext.js';
import { findTokens, pairTokens, extractCrossPage } from '../src/coords.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, 'fixtures', 'sample.pdf');

let pages = []; // [{text, spans, pairs}]

before(async () => {
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(fixture));
  const doc = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false }).promise;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const { text, spans } = buildPageText(tc);
    const tokens = findTokens(text);
    pages.push({ text, spans, tokens, pairs: pairTokens(tokens, text) });
  }
});

function close(a, b, eps = 1e-3) {
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);
}

test('sample PDF has two pages', () => {
  assert.equal(pages.length, 2);
});

test('page 1 finds all five coordinate pairs', () => {
  const pairs = pages[0].pairs;
  assert.equal(pairs.length, 5, `got: ${JSON.stringify(pairs.map((p) => [p.lat?.raw, p.lon?.raw]))}`);
  const get = (i) => [pairs[i].lat?.dd ?? null, pairs[i].lon?.dd ?? null];

  close(get(0)[0], 41.40339); // 41°24'12.2"N
  close(get(0)[1], 2.17403);
  close(get(1)[0], 12.5); // 12o30'N (letter o, split "W" pair across lines)
  close(get(1)[1], -45.25);
  close(get(2)[0], -33.865143); // bare decimal pair
  close(get(2)[1], 151.2099);
  close(get(3)[0], 40.44611); // space-separated DMS
  close(get(3)[1], -79.98222);
  close(get(4)[0], -33.8688); // Lat./Long. labels with hemisphere words
  close(get(4)[1], 151.2093);
});

test('page 2 (prose, years, depths) finds nothing', () => {
  assert.equal(pages[1].pairs.length, 0,
    `false positives: ${JSON.stringify(pages[1].pairs.map((p) => [p.lat?.raw, p.lon?.raw]))}`);
});

test('detected matches map back to page rectangles', () => {
  const { spans, pairs } = pages[0];
  for (const pair of pairs) {
    for (const tok of [pair.lat, pair.lon]) {
      if (!tok) continue;
      const rects = rectsForRange(spans, tok.start, tok.end);
      assert.ok(rects.length > 0, `no rects for ${tok.raw}`);
      for (const [x1, y1, x2, y2] of rects) {
        assert.ok(x2 > x1 && y2 > y1, `degenerate rect for ${tok.raw}`);
        assert.ok(x1 >= 0 && x2 <= 612 && y1 >= 0 && y2 <= 792, `rect off page for ${tok.raw}`);
      }
    }
  }
});

test('the page 1 → page 2 boundary yields no phantom cross-page pairs', () => {
  const pairs = extractCrossPage(pages[0].text, pages[1].text);
  assert.equal(pairs.length, 0,
    `phantom cross-page pairs: ${JSON.stringify(pairs.map((p) => [p.lat?.raw, p.lon?.raw]))}`);
});

test('line-broken pair spans two lines of the column', () => {
  // "12o30'N,\n45o15'W" — the pair crosses a newline in the built text.
  const { text, pairs } = pages[0];
  const p = pairs.find((x) => x.lat && Math.abs(x.lat.dd - 12.5) < 1e-6);
  assert.ok(p, 'split pair not found');
  const wholeMatch = text.slice(p.lat.start, p.lon.end);
  assert.ok(wholeMatch.includes('\n'), `expected a newline inside ${JSON.stringify(wholeMatch)}`);
});

// Integration test over docs/demo.pdf, the README demo article: every messy
// coordinate form it showcases must still be found at the Balanced net, and
// none of its look-alike numbers (years, elevations, page ranges, "at least
// 14", "25–30 degrees") may turn into a row. Regenerate the PDF with
// `node tools/make-demo-pdf.mjs`; if a parser change moves a value here, fix
// the parser or update this list and the README screenshot together.
// Prereq: `npm install` (imports pdfjs-dist).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildPageText } from '../src/pdftext.js';
import { extractCoordinates, extractCrossPage } from '../src/coords.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(__dirname, '..', 'docs');
const NET = 7; // Balanced: the level the README screenshot uses

async function pageTexts(file) {
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(path.join(docs, file)));
  const doc = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false }).promise;
  const texts = [];
  for (let p = 1; p <= doc.numPages; p++) {
    texts.push(buildPageText(await (await doc.getPage(p)).getTextContent()).text);
  }
  return texts;
}

// [page, lat, lon, form] in reading order. Page 1 ends on a latitude whose
// longitude opens page 2, so each page also reports that lone half.
const EXPECTED = [
  [1, -0.7426, -77.7372, 'Lat./Long. labels'],
  [1, 0.4651, -77.8912, 'decimal degrees with ° and hemisphere'],
  [1, -0.21861, -78.50972, 'classic DMS'],
  [1, 4.60972, -74.08167, 'Unicode primes ′ ″'],
  [1, -12.04333, -77.02833, 'curly quotes as ticks'],
  [1, -13.51667, -71.96667, 'backtick and acute as ticks'],
  [1, -2.16667, -79.88333, 'letter o as degree sign'],
  [1, -22.90306, -43.20944, "doubled '' as seconds"],
  [1, -2.75, null, 'lone latitude'],
  [1, -0.7393, -90.3134, 'unlabelled lon-first pair, en-dash minus'],
  [1, -0.00222, -78.45583, 'hemisphere first'],
  [1, -0.21667, -78.05, 'pair wrapped across lines'],
  [1, -0.9, -77.80806, 'one coordinate wrapped across lines'],
  [1, 9.73812, -83.78125, 'decimal minutes, no minute mark'],
  [1, 17, -104.76667, 'dropped degree sign'],
  [1, -34.6, -58.36667, 'Oeste'],
  [1, 4.93333, -52.33333, 'Ouest'],
  [1, -0.05, null, 'first half of the cross-page pair'],
  [2, null, -78.76667, 'second half of the cross-page pair'],
  [2, -0.67417, -76.39778, 'table: Unicode primes'],
  [2, -1.4, -78.41667, 'table: ring ˚ as degree sign'],
  [2, -1.48333, -78, 'table: Deg spelled out'],
  [2, -3.98333, -79.2, 'table: O for West'],
  [2, -0.36667, -78.13333, 'table: º and hemisphere words'],
  [2, -0.98639, -77.81389, 'table: stray closing tick'],
  [2, -4.0675, -78.95611, 'table: space-separated DMS'],
  [2, -0.25083, -76.17778, 'table: slash between halves'],
  [2, -0.6875, -90.325, 'table: degrees and decimal minutes'],
  [2, -2.89711, -79.00422, 'table: decimal comma in seconds'],
  [2, -3.4011, -78.5764, 'table: decimal degrees with hemisphere letters'],
  [2, -2.3087, -78.1184, 'signed decimals with true minus −'],
];

let texts;
before(async () => { texts = await pageTexts('demo.pdf'); });

const near = (a, b) => (a == null || b == null ? a === b : Math.abs(a - b) < 1e-4);

test('demo PDF: every showcased form is found, and nothing else', () => {
  const found = texts.flatMap((text, i) =>
    extractCoordinates(text, NET).map((p) => [i + 1, p.lat?.dd ?? null, p.lon?.dd ?? null]));
  assert.equal(found.length, EXPECTED.length,
    `found ${JSON.stringify(found)}`);
  EXPECTED.forEach(([page, lat, lon, form], i) => {
    const [fp, flat, flon] = found[i];
    assert.ok(fp === page && near(flat, lat) && near(flon, lon),
      `${form}: expected p${page} ${lat}, ${lon}; got p${fp} ${flat}, ${flon}`);
  });
});

test('demo PDF: the pair split over the page break joins up', () => {
  const pairs = extractCrossPage(texts[0], texts[1], NET);
  assert.equal(pairs.length, 1);
  assert.ok(near(pairs[0].lat.dd, -0.05) && near(pairs[0].lon.dd, -78.76667));
});

test('scanned demo PDF has no text layer', async () => {
  const scanned = await pageTexts('demo-scanned.pdf');
  assert.equal(scanned.length, 2);
  assert.ok(scanned.every((t) => t.trim() === ''));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findTokens,
  extractCoordinates,
  extractCrossPage,
  parseSingle,
  formatDD,
  formatDMS,
} from '../src/coords.js';

function close(a, b, eps = 1e-4) {
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);
}

test('classic DMS pair with degree symbol', () => {
  const pairs = extractCoordinates(`The site lies at 41°24'12.2"N 2°10'26.5"E in Spain.`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 41.40339);
  close(pairs[0].lon.dd, 2.17403);
});

test('letter o used as degree symbol', () => {
  const pairs = extractCoordinates(`collected at 12o30'N, 45o15'W during 2019`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 12.5);
  close(pairs[0].lon.dd, -45.25);
});

test('o with space before digits is not a degree mark', () => {
  const tokens = findTokens(`meet at 12 o'clock sharp`);
  assert.equal(tokens.filter((t) => t.strength === 'strong').length, 0);
});

test('decimal degrees pair, comma separated', () => {
  const pairs = extractCoordinates(`Barcelona (41.40338, 2.17403) was sampled.`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 41.40338);
  close(pairs[0].lon.dd, 2.17403);
});

test('decimal degrees with hemisphere letters', () => {
  const pairs = extractCoordinates(`stations at 33.8688 S, 151.2093 E were used`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, -33.8688);
  close(pairs[0].lon.dd, 151.2093);
});

test('negative decimal degrees', () => {
  const pairs = extractCoordinates(`located at -33.865143, 151.209900 near Sydney`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, -33.865143);
  close(pairs[0].lon.dd, 151.2099);
});

test('unicode prime marks', () => {
  const pairs = extractCoordinates(`40°26′46″N 79°58′56″W`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 40.44611);
  close(pairs[0].lon.dd, -79.98222);
});

test('curly quotes and backtick ticks', () => {
  const pairs = extractCoordinates(`40°26’46”N, 79°58\`56“W`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 40.44611);
  close(pairs[0].lon.dd, -79.98222);
});

test('doubled minute marks as seconds', () => {
  const pairs = extractCoordinates(`40°26'46''N 79°58'56''W`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 40.44611);
});

test('hemisphere-first DMS', () => {
  const pairs = extractCoordinates(`N41°24'12" W002°10'26"`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 41.40333);
  close(pairs[0].lon.dd, -2.17389);
});

test('space separated DMS with hemisphere', () => {
  const pairs = extractCoordinates(`grid ref 41 24 12.2 N, 2 10 26.5 E noted`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 41.40339);
  close(pairs[0].lon.dd, 2.17403);
});

test('degrees and decimal minutes', () => {
  const pairs = extractCoordinates(`waypoint 41°24.117'N 2°10.44'E stored`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 41.40195);
  close(pairs[0].lon.dd, 2.174);
});

test('coordinate split across a line break', () => {
  const pairs = extractCoordinates(`the locality (41°24'12"N,\n2°10'26"E) was surveyed`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 41.40333);
  close(pairs[0].lon.dd, 2.17389);
});

test('pair split across a line break mid-token', () => {
  const pairs = extractCoordinates(`at 41°\n24'12"N, 2°10'26"E today`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 41.40333);
});

test('decimal comma in DMS seconds', () => {
  const pairs = extractCoordinates(`Punkt 41°24'12,2"N 2°10'26,5"E gemessen`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 41.40339);
});

test('lone strong latitude kept as half pair', () => {
  const pairs = extractCoordinates(`latitude of 41°24'12"N only`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 41.40333);
  assert.equal(pairs[0].lon, null);
});

test('lat/long word labels', () => {
  const pairs = extractCoordinates(`Lat. 41.40338, Long. 2.17403 recorded`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 41.40338);
  close(pairs[0].lon.dd, 2.17403);
});

test('years and plain integers are not coordinates', () => {
  const pairs = extractCoordinates(`In 2019 we sampled 45 sites over 12 days at 300 m depth.`);
  assert.equal(pairs.length, 0);
});

test('page ranges and citations are not coordinates', () => {
  const pairs = extractCoordinates(`see pages 120-134 and Figs. 2, 3`);
  assert.equal(pairs.length, 0);
});

test('out-of-range values rejected', () => {
  const pairs = extractCoordinates(`impossible 95°30'12"N 200°10'26"E here`);
  assert.equal(pairs.length, 0);
});

test('minutes >= 60 rejected', () => {
  const tokens = findTokens(`bogus 41°75'12"N value`);
  assert.equal(tokens.filter((t) => t.isDMS).length, 0);
});

test('degree sign variant º and full hemisphere words', () => {
  const pairs = extractCoordinates(`12º30' South, 45º15' West of the ridge`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, -12.5);
  close(pairs[0].lon.dd, -45.25);
});

test('lon > 90 forces axis swap when unlabeled', () => {
  const pairs = extractCoordinates(`point at 151.2093, -33.8688 (lon-first)`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, -33.8688);
  close(pairs[0].lon.dd, 151.2093);
});

test('multiple pairs in one block', () => {
  const text = `Site A: 41°24'12"N 2°10'26"E. Later, Site B: 33.8688 S, 151.2093 E.`;
  const pairs = extractCoordinates(text);
  assert.equal(pairs.length, 2);
});

// --- intensity levels ------------------------------------------------------

test('intensity 1 requires strong evidence on both halves', () => {
  // Bare decimal pair: fine at default, dropped at strict.
  assert.equal(extractCoordinates(`Barcelona (41.40338, 2.17403)`, 1).length, 0);
  assert.equal(extractCoordinates(`Barcelona (41.40338, 2.17403)`, 3).length, 1);
  // Both halves strong: kept even at strict.
  assert.equal(extractCoordinates(`41°24'12"N 2°10'26"E`, 1).length, 1);
  // Lone strong token: dropped at strict, kept from level 2 up.
  assert.equal(extractCoordinates(`latitude of 41°24'12"N only`, 1).length, 0);
  assert.equal(extractCoordinates(`latitude of 41°24'12"N only`, 2).length, 1);
});

test('intensity 2 needs one unambiguous half to pair', () => {
  assert.equal(extractCoordinates(`Barcelona (41.40338, 2.17403)`, 2).length, 0);
  assert.equal(extractCoordinates(`stations at 33.8688 S, 151.2093 E`, 2).length, 1);
});

test('intensity 4 pairs single-decimal numbers', () => {
  const text = `the site (41.4, 2.2) was sampled`;
  assert.equal(extractCoordinates(text, 3).length, 0); // needs 2 decimals at default
  const wide = extractCoordinates(text, 4);
  assert.equal(wide.length, 1);
  close(wide[0].lat.dd, 41.4);
});

test('intensity 5 pairs bare integers', () => {
  const pairs = extractCoordinates(`grid cell 41, 2 in the survey`, 5);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 41);
  close(pairs[0].lon.dd, 2);
  // …which stays rejected at every lower level.
  assert.equal(extractCoordinates(`grid cell 41, 2 in the survey`, 4).length, 0);
});

test('default intensity is unchanged historical behaviour', () => {
  assert.equal(
    extractCoordinates(`In 2019 we sampled 45 sites over 12 days.`).length,
    extractCoordinates(`In 2019 we sampled 45 sites over 12 days.`, 3).length
  );
});

// --- cross-page pairs -------------------------------------------------------

test('pair split across a page boundary is found', () => {
  const prev = `Some intro text. The colony was located at 41°24'12"N`;
  const next = `2°10'26"E as recorded in the field notes.`;
  const pairs = extractCrossPage(prev, next);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 41.40333);
  close(pairs[0].lon.dd, 2.17389);
  // lat sits entirely on the previous page, lon on the next
  assert.deepEqual(pairs[0].lat.segs.map((s) => s.page), ['prev']);
  assert.deepEqual(pairs[0].lon.segs.map((s) => s.page), ['next']);
  // segment offsets are page-local: they slice back to the matched text
  const latSeg = pairs[0].lat.segs[0];
  assert.match(prev.slice(latSeg.start, latSeg.end), /41°24'12"N/);
  const lonSeg = pairs[0].lon.segs[0];
  assert.match(next.slice(lonSeg.start, lonSeg.end), /2°10'26"E/);
});

test('single token broken by the page break maps to both pages', () => {
  const prev = `data were collected at 41°`;
  const next = `24'12"N, 2°10'26"E during spring`;
  const pairs = extractCrossPage(prev, next);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 41.40333);
  assert.deepEqual(pairs[0].lat.segs.map((s) => s.page), ['prev', 'next']);
});

test('pairs entirely on one page are not reported as cross-page', () => {
  const prev = `site A: 41°24'12"N 2°10'26"E — done.`;
  const next = `site B: 33°52'8"S 151°12'33"E — done.`;
  assert.equal(extractCrossPage(prev, next).length, 0);
});

// --- parseSingle / formatting -------------------------------------------

test('parseSingle cleans messy DMS input', () => {
  close(parseSingle(`41o24'12.2"N`, 'lat'), 41.40339);
  close(parseSingle(`2°10'26.5" W`, 'lon'), -2.17403);
  close(parseSingle('-33.8688', 'lat'), -33.8688);
  assert.equal(parseSingle('not a coord', 'lat'), null);
  assert.equal(parseSingle('95.5', 'lat'), null);
});

test('formatDD trims trailing zeros', () => {
  assert.equal(formatDD(41.5), '41.5');
  assert.equal(formatDD(-2.174035), '-2.174035');
});

test('formatDMS round trips', () => {
  assert.equal(formatDMS(41.40339, 'lat'), `41°24'12.2"N`);
  assert.equal(formatDMS(-2.17403, 'lon'), `2°10'26.51"W`);
  const rt = parseSingle(formatDMS(-33.8688, 'lat'), 'lat');
  close(rt, -33.8688, 1e-4);
});

test('formatDMS handles rounding at 60s boundary', () => {
  assert.equal(formatDMS(41.9999999, 'lat'), `42°00'00"N`);
});

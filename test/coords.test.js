// Tests for src/coords.js (tokenizer/parser/formatter/cross-page). No need to
// run unless you changed coords.js. Prereq: `npm install`. Run: `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findTokens,
  extractCoordinates,
  extractCrossPage,
  parseSingle,
  formatDD,
  formatDMS,
  DEFAULT_INTENSITY,
  MAX_INTENSITY,
  INTENSITY_LABELS,
  LEGACY_INTENSITY_MAP,
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

// Some of these exercise deliberately weak evidence — a bare decimal pair, a
// coordinate with nothing but a "Lat." label — which the default net (Strictest
// since 0.6.0) is meant to reject. They name the level they were written for,
// BALANCED, rather than riding on whatever the default happens to be; the
// intensity block further down is what pins the default itself.
const BALANCED = 7;

test('decimal degrees pair, comma separated', () => {
  const pairs = extractCoordinates(`Barcelona (41.40338, 2.17403) was sampled.`, BALANCED);
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
  const pairs = extractCoordinates(`located at -33.865143, 151.209900 near Sydney`, BALANCED);
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

// PDF text wraps a coordinate onto an indented continuation line; the token must
// absorb the newline PLUS the indentation instead of stopping at "104°" and
// silently dropping the minutes/seconds.
test('token split across an indented line wrap keeps minutes/seconds', () => {
  const indent = ' '.repeat(14);
  const pairs = extractCoordinates(`19°35'47"N, 104°\n${indent}43'46"W here`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 19.59639);
  close(pairs[0].lon.dd, -104.72944); // NOT -104.0 — the 43'46" survived the wrap
});

test('a pair wrapped onto a deeply indented next line still joins', () => {
  const indent = ' '.repeat(20);
  const pairs = extractCoordinates(`19°35'47"N,\n${indent}104°43'46"W`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lon.dd, -104.72944);
});

// "O" = Oeste (Spanish/Portuguese) / Ouest (French) = West. The image that
// prompted this had "104°43'46\"O"; without the mapping it read +104.7 (East).
test('letter O and the word Oeste/Ouest read as West', () => {
  for (const west of [`104°43'46"O`, `104°43'46" O.`, `104°43'46" Oeste`, `104°43'46" Ouest`]) {
    const pairs = extractCoordinates(`19°35'47"N, ${west}`);
    assert.equal(pairs.length, 1, west);
    close(pairs[0].lon.dd, -104.72944);
  }
});

// A bare integer followed by a lone "O" is not a coordinate — the West only
// counts when the token carries a degree mark, minutes, or a decimal fraction.
test('a lone O after a bare integer is not treated as West', () => {
  assert.equal(extractCoordinates(`caught 5 O. specimens`).length, 0);
  assert.equal(extractCoordinates(`19°35'47"N, 104 O`).some((p) => p.lon), false);
});

test('decimal comma in DMS seconds', () => {
  const pairs = extractCoordinates(`Punkt 41°24'12,2"N 2°10'26,5"E gemessen`);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 41.40339);
});

test('lone strong latitude kept as half pair', () => {
  // Level 2 is the first that keeps anything alone; Strictest keeps nothing.
  const pairs = extractCoordinates(`latitude of 41°24'12"N only`, 2);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 41.40333);
  assert.equal(pairs[0].lon, null);
});

test('lat/long word labels', () => {
  const pairs = extractCoordinates(`Lat. 41.40338, Long. 2.17403 recorded`, BALANCED);
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
  const pairs = extractCoordinates(`point at 151.2093, -33.8688 (lon-first)`, BALANCED);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, -33.8688);
  close(pairs[0].lon.dd, 151.2093);
});

test('multiple pairs in one block', () => {
  const text = `Site A: 41°24'12"N 2°10'26"E. Later, Site B: 33.8688 S, 151.2093 E.`;
  const pairs = extractCoordinates(text);
  assert.equal(pairs.length, 2);
});

// --- intensity levels (1 strictest … 12 everything; 1 = default) ------------
// The scale grew from 7 steps to 12 in 0.6.0. Every old level still exists at a
// new number (LEGACY_INTENSITY_MAP): 1→1, 2→2, 3→3, 4→5, 5→7, 6→9, 7→11.

test('levels 1–2 require strong evidence on both halves', () => {
  // Bare decimal pair (weak+weak): dropped through the strict end, kept at the
  // Balanced level.
  for (const l of [1, 2, 3, 4, 5, 6]) assert.equal(extractCoordinates(`Barcelona (41.40338, 2.17403)`, l).length, 0, `level ${l}`);
  assert.equal(extractCoordinates(`Barcelona (41.40338, 2.17403)`, 7).length, 1);
  // Both halves strong: kept even at the strictest level.
  assert.equal(extractCoordinates(`41°24'12"N 2°10'26"E`, 1).length, 1);
  // Lone strong token: dropped at level 1 (nothing kept alone), kept from 2 up.
  assert.equal(extractCoordinates(`latitude of 41°24'12"N only`, 1).length, 0);
  assert.equal(extractCoordinates(`latitude of 41°24'12"N only`, 2).length, 1);
});

test('levels 3–4 (Firm) need the partner to be solid; 5–6 (Careful) do not', () => {
  // One strong half (DMS+hemisphere) + one weak half (bare 2-decimal number).
  const text = `41°24'12"N, 2.17403 recorded`;
  // Firm: the weak longitude is not pulled in — the strong latitude survives
  // alone (lone-strong is kept), but with no partner.
  for (const l of [3, 4]) {
    const firm = extractCoordinates(text, l);
    assert.equal(firm.length, 1, `level ${l}`);
    close(firm[0].lat.dd, 41.40333);
    assert.equal(firm[0].lon, null, `level ${l}`);
  }
  // Careful: a strong half drags the weak partner into a full pair.
  for (const l of [5, 6]) {
    const careful = extractCoordinates(text, l);
    assert.equal(careful.length, 1, `level ${l}`);
    close(careful[0].lat.dd, 41.40333);
    close(careful[0].lon.dd, 2.17403);
  }
});

test('level 7 (Balanced) pairs two weak decimals; level 6 does not', () => {
  const text = `Barcelona (41.40338, 2.17403)`;
  assert.equal(extractCoordinates(text, 6).length, 0);
  assert.equal(extractCoordinates(text, 7).length, 1);
});

test('level 9 (Wide) pairs single-decimal numbers', () => {
  const text = `the site (41.4, 2.2) was sampled`;
  assert.equal(extractCoordinates(text, 8).length, 0); // needs 2 decimals below 9
  const wide = extractCoordinates(text, 9);
  assert.equal(wide.length, 1);
  close(wide[0].lat.dd, 41.4);
});

test('level 11 (Everything) pairs bare integers', () => {
  const pairs = extractCoordinates(`grid cell 41, 2 in the survey`, 11);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 41);
  close(pairs[0].lon.dd, 2);
  // …which stays rejected at every lower level.
  assert.equal(extractCoordinates(`grid cell 41, 2 in the survey`, 10).length, 0);
});

test('a "(wider gap)" step differs from its twin only in the gap it allows', () => {
  // Levels 3 and 4 apply the same pairing rule; 4 just tolerates more text
  // between the halves (30 chars vs 33).
  const far = `41°24'12"N${' '.repeat(35)}2°10'26"E`;
  const firm = extractCoordinates(far, 3);
  assert.equal(firm.length, 2); // too far apart: two lone halves, unpaired
  assert.equal(firm[0].lon, null);
  assert.equal(firm[1].lat, null);
  const wider = extractCoordinates(far, 4);
  assert.equal(wider.length, 1);
  close(wider[0].lat.dd, 41.40333);
  close(wider[0].lon.dd, 2.17389);
});

test('level count, labels and default', () => {
  assert.equal(MAX_INTENSITY, 12);
  assert.equal(DEFAULT_INTENSITY, 1);
  for (let l = 1; l <= MAX_INTENSITY; l++) {
    assert.ok(INTENSITY_LABELS[l], `level ${l} needs a label`);
    assert.ok(INTENSITY_LABELS[l].includes(' — '), `level ${l} label needs "Name — description"`);
  }
  // Every old level maps onto a real one (persist.js migrates snapshots with this).
  for (const [old, now] of Object.entries(LEGACY_INTENSITY_MAP)) {
    assert.ok(now >= 1 && now <= MAX_INTENSITY, `old level ${old} maps out of range`);
    assert.ok(INTENSITY_LABELS[now], `old level ${old} maps to a level with no label`);
  }
  assert.equal(LEGACY_INTENSITY_MAP[1], 1); // strictest stayed put
  assert.equal(LEGACY_INTENSITY_MAP[7], 11); // old "everything"
  // Out-of-range values clamp rather than throw.
  assert.doesNotThrow(() => extractCoordinates(`41°24'12"N 2°10'26"E`, 99));
  assert.equal(extractCoordinates(`41°24'12"N 2°10'26"E`, 0).length, 1);
});

test('default intensity is the strictest net', () => {
  const text = `Barcelona (41.40338, 2.17403)`;
  assert.equal(extractCoordinates(text).length, extractCoordinates(text, 1).length);
  assert.equal(extractCoordinates(text).length, 0); // strictest drops a bare decimal pair
  assert.equal(extractCoordinates(`41°24'12"N 2°10'26"E`).length, 1);
});

// --- 0.6.0 parser fixes -----------------------------------------------------

test('a trailing hemisphere beats a leading one', () => {
  // The N belongs to a latitude the parser cannot read ("17'"), and used to be
  // absorbed as the longitude's leading hemisphere — making it a 104° latitude,
  // which failed the ±90 check and threw the good longitude away with it.
  const pairs = extractCoordinates(`100 ft., 17' N 104°46' W, mango plantation`, 1);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 17);
  close(pairs[0].lon.dd, -104.76667);
});

test('a hemisphere on both sides resolves to the trailing one', () => {
  // Real text from the corpus: the latitude carries no hemisphere, so the N
  // that follows it reads as the longitude's prefix. The trailing W wins.
  const pairs = extractCoordinates(`9°44.287 N 83°46.875 W`, 1);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 9.73812);
  close(pairs[0].lon.dd, -83.78125);
});

test('a tick where the minutes would be counts as evidence', () => {
  // Degrees dropped by the typesetter: number + minute tick + hemisphere.
  const [pair] = extractCoordinates(`at 17' N 104°46' W`, 1);
  close(pair.lat.dd, 17);
  // On its own, with no hemisphere, it is still not a coordinate.
  assert.equal(extractCoordinates(`a 17' length and a 3' width`, 7).length, 0);
  // A seconds tick in that position is the tail of an unparsed coordinate (here
  // the minutes are 96, so the whole DMS token is rejected), not a coordinate of
  // its own — it must not stand alone and steal the pairing from its neighbours.
  const stolen = extractCoordinates(`3°96'46''S:73°15'49''W [-4.613°, -73.264°]`, 1);
  assert.equal(stolen.length, 1);
  close(stolen[0].lat.dd, -4.613);
  close(stolen[0].lon.dd, -73.26361);
});

test('a stray closing tick after the seconds is absorbed', () => {
  const pairs = extractCoordinates(`16°43'59''N 88°59'11'W`, 1);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 16.73306);
  close(pairs[0].lon.dd, -88.98639); // the trailing 'W is read, not dropped
});

test('"least" is not read as "east"', () => {
  // The most common false positive in real papers, at every level.
  for (const l of [1, 5, 7, 11]) {
    assert.equal(extractCoordinates(`we know Darwin had at least 14 collecting events`, l).length, 0, `level ${l}`);
    assert.equal(extractCoordinates(`separated by at least 2 punctures`, l).length, 0, `level ${l}`);
  }
  // A hemisphere word that really does start a word still works.
  const pairs = extractCoordinates(`recorded at east 14.5 and north 40.5`, 7);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, 40.5);
  close(pairs[0].lon.dd, 14.5);
});

test('a word ending in a hemisphere letter is not a hemisphere', () => {
  assert.equal(extractCoordinates(`the ANDES 40 transect`, 7).length, 0);
  // …but a genuine standalone letter still is.
  assert.equal(extractCoordinates(`at S 40.5 and W 30.25`, 7).length, 1);
});

test('degrees spelled out as "Deg" when it touches the number', () => {
  const pairs = extractCoordinates(`vic. Caucalandia 10Deg 32'S 62Deg 48'W collected`, 1);
  assert.equal(pairs.length, 1);
  close(pairs[0].lat.dd, -10.53333);
  close(pairs[0].lon.dd, -62.8);
  // Detached, it is ordinary prose about angles or temperature, not a location.
  assert.equal(extractCoordinates(`mandibles reflexed at 25-30 degrees from base`, 7).length, 0);
  assert.equal(extractCoordinates(`gridded at 0.1 degree spatial resolution`, 7).length, 0);
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

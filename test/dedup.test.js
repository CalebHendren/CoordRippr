// Tests for src/dedup.js (duplicate-coordinate detection). No need to run
// unless you changed dedup.js. Prereq: `npm install`. Run: `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicateRowIds, hasCoordinate } from '../src/dedup.js';

// Minimal row factory matching the fields dedup reads.
function row(id, lat, lon, { cells = [], fileId = 'f1', latRaw = null, lonRaw = null } = {}) {
  return { id, lat, lon, latRaw, lonRaw, cells, src: fileId ? { fileId } : null };
}

test('removes later rows that repeat a coordinate, keeps the first', () => {
  const rows = [
    row('a', 41.40338, 2.17403),
    row('b', 41.40338, 2.17403),
    row('c', 33.8688, 151.2093),
    row('d', 41.40338, 2.17403),
  ];
  assert.deepEqual(findDuplicateRowIds(rows), ['b', 'd']);
});

test('tiny floating-point noise below 6 dp is treated as identical', () => {
  const rows = [
    row('a', 41.4033801, 2.1740299),
    row('b', 41.4033804, 2.1740302),
  ];
  assert.deepEqual(findDuplicateRowIds(rows), ['b']);
});

test('distinct coordinates are never removed', () => {
  const rows = [
    row('a', 41.4, 2.1),
    row('b', 41.5, 2.1),
    row('c', 41.4, 2.2),
  ];
  assert.deepEqual(findDuplicateRowIds(rows), []);
});

test('sameCols: only a duplicate when columns 1 & 2 also match', () => {
  const rows = [
    row('a', 41.4, 2.1, { cells: ['Panthera', 'leo'] }),
    row('b', 41.4, 2.1, { cells: ['Panthera', 'leo'] }),   // dup of a
    row('c', 41.4, 2.1, { cells: ['Canis', 'lupus'] }),    // same coord, diff species
  ];
  assert.deepEqual(findDuplicateRowIds(rows, { sameCols: true }), ['b']);
  // Without the option, all three collapse to the first.
  assert.deepEqual(findDuplicateRowIds(rows), ['b', 'c']);
});

test('sameCols comparison ignores case and surrounding whitespace', () => {
  const rows = [
    row('a', 10, 20, { cells: ['Panthera', 'leo'] }),
    row('b', 10, 20, { cells: [' panthera ', 'LEO'] }),
  ];
  assert.deepEqual(findDuplicateRowIds(rows, { sameCols: true }), ['b']);
});

test('samePdf: identical coordinates in different PDFs are kept', () => {
  const rows = [
    row('a', 41.4, 2.1, { fileId: 'f1' }),
    row('b', 41.4, 2.1, { fileId: 'f2' }),  // same coord, other PDF
    row('c', 41.4, 2.1, { fileId: 'f1' }),  // dup of a within f1
  ];
  assert.deepEqual(findDuplicateRowIds(rows, { samePdf: true }), ['c']);
  // Without the option, b collapses into a too.
  assert.deepEqual(findDuplicateRowIds(rows), ['b', 'c']);
});

test('both options combine (same coord + cols + PDF)', () => {
  const rows = [
    row('a', 1, 2, { cells: ['X', 'y'], fileId: 'f1' }),
    row('b', 1, 2, { cells: ['X', 'y'], fileId: 'f1' }), // full dup
    row('c', 1, 2, { cells: ['X', 'y'], fileId: 'f2' }), // other PDF
    row('d', 1, 2, { cells: ['Z', 'y'], fileId: 'f1' }), // other col1
  ];
  assert.deepEqual(findDuplicateRowIds(rows, { sameCols: true, samePdf: true }), ['b']);
});

test('rows with no coordinate at all are never removed', () => {
  const rows = [
    row('a', null, null, { cells: ['', ''] }),
    row('b', null, null, { cells: ['', ''] }),
    row('c', 41.4, 2.1),
    row('d', 41.4, 2.1),
  ];
  assert.deepEqual(findDuplicateRowIds(rows), ['d']);
});

test('half pairs (lat only) de-duplicate on the present half', () => {
  const rows = [
    row('a', 41.40333, null),
    row('b', 41.40333, null),
    row('c', 41.40333, 2.5),   // has a lon -> a different key
  ];
  assert.deepEqual(findDuplicateRowIds(rows), ['b']);
});

test('unparseable raw values compare by their literal text', () => {
  const rows = [
    row('a', null, null, { latRaw: 'not a coord', lonRaw: '' }),
    row('b', null, null, { latRaw: 'not a coord', lonRaw: '' }),  // dup
    row('c', null, null, { latRaw: 'other junk', lonRaw: '' }),   // different text
  ];
  assert.deepEqual(findDuplicateRowIds(rows), ['b']);
});

test('hasCoordinate reflects whether a row carries any coordinate value', () => {
  assert.equal(hasCoordinate(row('a', 41.4, 2.1)), true);
  assert.equal(hasCoordinate(row('a', 41.4, null)), true);
  assert.equal(hasCoordinate(row('a', null, null)), false);
  assert.equal(hasCoordinate(row('a', null, null, { latRaw: 'x' })), true);
});

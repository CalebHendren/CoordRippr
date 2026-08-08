// Tests for src/persist.js (packState/unpackState snapshot round-trip). No need
// to run unless you changed persist.js. Prereq: `npm install`. Run: `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packState, unpackState, migrateSnapshot, SNAPSHOT_VERSION } from '../src/persist.js';
import { DEFAULT_INTENSITY, LEGACY_INTENSITY_MAP } from '../src/coords.js';

function sampleState() {
  const dets = new Map();
  dets.set('d1', {
    id: 'd1', fileId: 'f1', pageNum: 2,
    rects: [[10, 20, 90, 32]], rowId: 'r1', half: 'lat', raw: `41°24'12"N`,
    span: [100, 111],
  });
  return {
    files: [{
      id: 'f1', name: 'paper.pdf', path: '/tmp/paper.pdf',
      doc: { fake: true }, error: null, numPages: 3, intensity: 5,
      pages: [
        { num: 1, w: 612, h: 792, proxy: { fake: true }, dets: [] },
        { num: 2, w: 612, h: 792, proxy: { fake: true }, dets: ['d1'] },
        { num: 3, w: 612, h: 792, proxy: { fake: true }, dets: [] },
      ],
    }],
    dets,
    rows: [
      {
        id: 'r1', cells: ['Fox', 'red', 'forest'], notes: 'seen at dusk', lat: 41.40333, lon: null,
        latRaw: null, lonRaw: 'garbage',
        src: { fileId: 'f1', pageNum: 2, latDet: 'd1', lonDet: null },
        llm: { verdict: 'ok', note: 'looks right' },
        llmSent: 1730000000000,
      },
      { id: 'r2', cells: ['', '', ''], notes: '', lat: null, lon: null, latRaw: null, lonRaw: null, src: null },
    ],
    cols: ['Animal', 'Color', 'Habitat'],
    notesOn: true,
    fmt: 'both',
    showAll: true,
    showHighlights: false,
    zoom: 1.8,
    intensity: 4,
    currentFile: 'f1',
    suppressed: new Set(['f1:2:lat:100']),
    selected: new Set(['r1']), // must not leak into the snapshot
    activeRow: 'r1',
    busy: false,
  };
}

test('packState produces a JSON-safe snapshot', () => {
  const snap = packState(sampleState(), 42);
  const rt = JSON.parse(JSON.stringify(snap));
  assert.equal(rt.v, SNAPSHOT_VERSION);
  assert.equal(rt.nextId, 42);
  assert.equal(rt.files[0].pages.length, 3);
  // live objects must not be captured
  assert.equal(rt.files[0].doc, undefined);
  assert.equal(rt.files[0].pages[0].proxy, undefined);
  assert.equal(rt.selected, undefined);
});

test('pack → unpack round trip preserves the session', () => {
  const state = sampleState();
  const restored = unpackState(JSON.parse(JSON.stringify(packState(state, 42))));
  assert.equal(restored.nextId, 42);
  assert.deepEqual(restored.cols, ['Animal', 'Color', 'Habitat']);
  assert.equal(restored.notesOn, true);
  assert.equal(restored.fmt, 'both');
  assert.equal(restored.showAll, true);
  assert.equal(restored.showHighlights, false);
  assert.equal(restored.zoom, 1.8);
  assert.equal(restored.intensity, 4);
  assert.equal(restored.currentFile, 'f1');
  assert.deepEqual([...restored.suppressed], ['f1:2:lat:100']);

  assert.equal(restored.files.length, 1);
  assert.equal(restored.files[0].doc, null); // reattached later by the app
  assert.equal(restored.files[0].intensity, 5); // per-PDF net override survives
  assert.equal(restored.files[0].hidden, false); // not set aside in the sample
  assert.equal(restored.files[0].pages[1].proxy, null);
  assert.deepEqual(restored.files[0].pages[1].dets, ['d1']);

  const det = restored.dets.get('d1');
  assert.deepEqual(det.rects, [[10, 20, 90, 32]]);
  assert.deepEqual(det.span, [100, 111]);

  assert.equal(restored.rows.length, 2);
  assert.deepEqual(restored.rows[0].cells, ['Fox', 'red', 'forest']);
  assert.equal(restored.rows[0].notes, 'seen at dusk');
  assert.equal(restored.rows[0].lonRaw, 'garbage');
  assert.equal(restored.rows[0].llm.verdict, 'ok');
  assert.equal(restored.rows[0].llmSent, 1730000000000);
  assert.equal(restored.rows[0].src.latDet, 'd1');
  assert.equal(restored.rows[1].src, null);
  assert.equal(restored.rows[1].llm, undefined);
  assert.equal(restored.rows[1].llmSent, undefined); // never sent stays unmarked
});

test('a file without an intensity override unpacks to null (follows the global net)', () => {
  const restored = unpackState({
    v: SNAPSHOT_VERSION,
    files: [{ id: 'f1', name: 'a.pdf', numPages: 1, pages: [{ num: 1, w: 1, h: 1, dets: [] }] }],
  });
  assert.equal(restored.files[0].intensity, null);
  assert.equal(restored.files[0].hidden, false); // absent hidden flag defaults to visible
});

test('a hidden PDF survives the pack → unpack round trip', () => {
  const state = sampleState();
  state.files[0].hidden = true;
  const restored = unpackState(JSON.parse(JSON.stringify(packState(state, 1))));
  assert.equal(restored.files[0].hidden, true);
});

test('content hashes survive the round trip, and are null when never computed', () => {
  const state = sampleState();
  state.files[0].byteHash = 'abc123';
  state.files[0].textHash = 'def456';
  const restored = unpackState(JSON.parse(JSON.stringify(packState(state, 1))));
  assert.equal(restored.files[0].byteHash, 'abc123');
  assert.equal(restored.files[0].textHash, 'def456');

  // A snapshot written before hashing existed carries neither; they are filled
  // in on demand rather than being treated as "matches everything".
  const older = unpackState(JSON.parse(JSON.stringify(packState(sampleState(), 1))));
  assert.equal(older.files[0].byteHash, null);
  assert.equal(older.files[0].textHash, null);
});

test('unpackState rejects garbage and fills defaults', () => {
  assert.equal(unpackState(null), null);
  assert.equal(unpackState({}), null);
  assert.equal(unpackState('nope'), null);
  const minimal = unpackState({ v: SNAPSHOT_VERSION, files: [] });
  assert.equal(minimal.fmt, 'dd');
  assert.equal(minimal.showHighlights, true); // default on when the field is absent
  assert.equal(minimal.zoom, 1.4);
  assert.equal(minimal.intensity, DEFAULT_INTENSITY); // strictest for a current snapshot
  assert.equal(minimal.nextId, 1);
  assert.deepEqual(minimal.cols, ['Genus', 'Species']);
  assert.equal(minimal.notesOn, false);
  assert.deepEqual(minimal.rows, []);
  assert.equal(minimal.dets.size, 0);
  assert.equal(minimal.suppressed.size, 0);
});

// --- snapshot v2 -> v3 migration (the 7-step net became 12 steps) -----------

test('migrateSnapshot remaps old net levels, global and per-PDF', () => {
  const v2 = {
    v: 2,
    intensity: 5, // old "Balanced"
    files: [
      { id: 'f1', name: 'a.pdf', intensity: 7 }, // old per-PDF "Everything"
      { id: 'f2', name: 'b.pdf', intensity: null }, // follows the global net
      { id: 'f3', name: 'c.pdf', intensity: 1 }, // strictest, unchanged
    ],
  };
  const out = migrateSnapshot(v2);
  assert.equal(out.v, SNAPSHOT_VERSION);
  assert.equal(out.intensity, LEGACY_INTENSITY_MAP[5]); // 5 -> 7
  assert.equal(out.files[0].intensity, LEGACY_INTENSITY_MAP[7]); // 7 -> 11
  assert.equal(out.files[1].intensity, null);
  assert.equal(out.files[2].intensity, 1);
  // The input is not touched.
  assert.equal(v2.intensity, 5);
  assert.equal(v2.files[0].intensity, 7);
});

test('a v2 snapshot with no net recorded keeps the old default, not the new one', () => {
  // Those sessions were scanned with the old Balanced net; silently restoring
  // them at the new strictest default would drop rows the user already had.
  const out = migrateSnapshot({ v: 2, files: [] });
  assert.equal(out.intensity, 7); // old Balanced on the new scale
  assert.notEqual(out.intensity, DEFAULT_INTENSITY);
});

test('a current snapshot passes through migrateSnapshot untouched', () => {
  const v3 = { v: SNAPSHOT_VERSION, intensity: 4, files: [{ id: 'f1', intensity: 12 }] };
  assert.equal(migrateSnapshot(v3), v3);
});

test('unpackState migrates an old snapshot on the way through', () => {
  const restored = unpackState({
    v: 2, intensity: 6, files: [{ id: 'f1', name: 'a.pdf', numPages: 1, intensity: 4, pages: [] }],
  });
  assert.equal(restored.intensity, LEGACY_INTENSITY_MAP[6]); // 6 -> 9
  assert.equal(restored.files[0].intensity, LEGACY_INTENSITY_MAP[4]); // 4 -> 5
});

// --- hand-drawn coordinate marks --------------------------------------------

test('manual detections and their rows survive a snapshot round-trip', () => {
  const dets = new Map();
  dets.set('d9', {
    id: 'd9', fileId: 'f1', pageNum: 4,
    rects: [[10, 20, 90, 32]], rowId: 'r9', half: 'lat',
    raw: "17' N 104°46' W", span: null, manual: true,
  });
  const state = {
    files: [{
      id: 'f1', name: 'paper.pdf', path: null, doc: null, error: null, numPages: 4,
      intensity: null, hidden: false,
      pages: [{ num: 4, w: 612, h: 792, proxy: null, dets: ['d9'] }],
    }],
    dets,
    rows: [{
      id: 'r9', cells: ['', ''], notes: '', lat: 17, lon: -104.76667,
      latRaw: null, lonRaw: null,
      src: { fileId: 'f1', pageNum: 4, latDet: 'd9', lonDet: null, extraDets: [], manual: true },
    }],
    cols: ['Genus', 'Species'],
    notesOn: false, fmt: 'dd', showAll: false, showHighlights: true,
    zoom: 1.4, intensity: 1, currentFile: 'f1', suppressed: new Set(),
  };
  const restored = unpackState(JSON.parse(JSON.stringify(packState(state, 10))));
  const det = restored.dets.get('d9');
  assert.equal(det.manual, true);
  assert.equal(det.span, null); // no text offset, so deleting it suppresses nothing
  assert.equal(restored.rows[0].src.manual, true);
  assert.equal(restored.rows[0].src.latDet, 'd9');
});

test('parser detections do not gain a manual flag', () => {
  const dets = new Map();
  dets.set('d1', {
    id: 'd1', fileId: 'f1', pageNum: 1, rects: [[1, 2, 3, 4]],
    rowId: 'r1', half: 'lat', raw: '41°N', span: [5, 9],
  });
  const state = {
    files: [{ id: 'f1', name: 'a.pdf', path: null, doc: null, error: null, numPages: 1, intensity: null, hidden: false, pages: [{ num: 1, w: 1, h: 1, proxy: null, dets: ['d1'] }] }],
    dets,
    rows: [{ id: 'r1', cells: ['', ''], notes: '', lat: 41, lon: null, latRaw: null, lonRaw: null, src: { fileId: 'f1', pageNum: 1, latDet: 'd1', lonDet: null } }],
    cols: ['Genus', 'Species'],
    notesOn: false, fmt: 'dd', showAll: false, showHighlights: true,
    zoom: 1.4, intensity: 1, currentFile: 'f1', suppressed: new Set(),
  };
  const packed = packState(state, 2);
  assert.equal('manual' in packed.dets[0], false);
});

test('migration does not rescue an unusable snapshot', () => {
  // A snapshot with no files array is garbage, not an empty session — the
  // migration must not manufacture one and let it through.
  assert.equal(unpackState({}), null);
  assert.equal(unpackState({ v: 2 }), null);
  assert.equal(unpackState({ v: 2, intensity: 5 }), null);
});

// Tests for src/persist.js (packState/unpackState snapshot round-trip). No need
// to run unless you changed persist.js. Prereq: `npm install`. Run: `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packState, unpackState, SNAPSHOT_VERSION } from '../src/persist.js';

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
      doc: { fake: true }, error: null, numPages: 3,
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

test('unpackState rejects garbage and fills defaults', () => {
  assert.equal(unpackState(null), null);
  assert.equal(unpackState({}), null);
  assert.equal(unpackState('nope'), null);
  const minimal = unpackState({ v: SNAPSHOT_VERSION, files: [] });
  assert.equal(minimal.fmt, 'dd');
  assert.equal(minimal.showHighlights, true); // default on when the field is absent
  assert.equal(minimal.zoom, 1.4);
  assert.equal(minimal.intensity, 3);
  assert.equal(minimal.nextId, 1);
  assert.deepEqual(minimal.cols, ['Genus', 'Species']);
  assert.equal(minimal.notesOn, false);
  assert.deepEqual(minimal.rows, []);
  assert.equal(minimal.dets.size, 0);
  assert.equal(minimal.suppressed.size, 0);
});

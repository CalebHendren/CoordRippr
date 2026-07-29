// Tests for src/projectio.js (the .crproj export bundle). No need to run unless
// you changed projectio.js. Prereq: `npm install`. Run: `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  packProjectFile,
  unpackProjectFile,
  uniqueProjectName,
  projectFileName,
  estimateExportSize,
  formatBytes,
  bytesToBase64,
  base64ToBytes,
  PROJECT_FILE_VERSION,
  PROJECT_FILE_EXT,
} from '../src/projectio.js';

const sampleSnapshot = () => ({
  v: 3,
  nextId: 12,
  cols: ['Genus', 'Species'],
  intensity: 1,
  files: [{ id: 'f1', name: 'Xenopygus.pdf', path: 'C:/Xantho/Xenopygus.pdf', pages: [] }],
  dets: [],
  rows: [{ id: 'r1', cells: ['Xenopygus', 'analis'], lat: 22.51667, lon: -99.35 }],
});

const bytes = (...values) => new Uint8Array(values).buffer;

test('base64 round-trips arbitrary bytes', () => {
  const original = new Uint8Array(1000);
  for (let i = 0; i < original.length; i++) original[i] = (i * 7) % 256;
  const back = new Uint8Array(base64ToBytes(bytesToBase64(original)));
  assert.deepEqual([...back], [...original]);
  // Empty and single-byte edge cases.
  assert.equal(bytesToBase64(new Uint8Array()), '');
  assert.deepEqual([...new Uint8Array(base64ToBytes(bytesToBase64(new Uint8Array([0]))))], [0]);
  // An ArrayBuffer is accepted as readily as a view.
  assert.equal(bytesToBase64(bytes(1, 2, 3)), bytesToBase64(new Uint8Array([1, 2, 3])));
});

test('pack → unpack round trip with embedded PDFs', () => {
  const snapshot = sampleSnapshot();
  const bundle = packProjectFile({
    project: { id: 'p1', name: 'Xantho' },
    snapshot,
    pdfs: [{ fileId: 'f1', name: 'Xenopygus.pdf', bytes: bytes(0x25, 0x50, 0x44, 0x46) }],
  });
  assert.equal(bundle.app, 'CoordRippr');
  assert.equal(bundle.v, PROJECT_FILE_VERSION);
  assert.ok(bundle.exportedAt > 0);

  // Must survive the JSON trip the file itself makes.
  const restored = unpackProjectFile(JSON.stringify(bundle));
  assert.equal(restored.name, 'Xantho');
  assert.deepEqual(restored.snapshot, snapshot);
  assert.equal(restored.pdfs.length, 1);
  assert.equal(restored.pdfs[0].fileId, 'f1');
  assert.equal(restored.pdfs[0].name, 'Xenopygus.pdf');
  assert.deepEqual([...new Uint8Array(restored.pdfs[0].bytes)], [0x25, 0x50, 0x44, 0x46]);
});

test('pack → unpack round trip without PDFs', () => {
  const bundle = packProjectFile({ project: { name: 'Rows only' }, snapshot: sampleSnapshot() });
  assert.deepEqual(bundle.pdfs, []);
  const restored = unpackProjectFile(bundle);
  assert.deepEqual(restored.pdfs, []);
  // The rows still come back in full — only the page images need the PDFs.
  assert.equal(restored.snapshot.rows[0].cells[0], 'Xenopygus');
});

test('unpackProjectFile rejects anything that is not an export', () => {
  assert.throws(() => unpackProjectFile('not json at all'), /not valid JSON/);
  assert.throws(() => unpackProjectFile('{}'), new RegExp(PROJECT_FILE_EXT));
  assert.throws(() => unpackProjectFile({ app: 'SomethingElse', snapshot: {} }), /not a CoordRippr/);
  assert.throws(() => unpackProjectFile({ app: 'CoordRippr' }), /not a CoordRippr/); // no snapshot
  assert.throws(() => unpackProjectFile(null), /not a CoordRippr/);
});

test('unpackProjectFile refuses a bundle from a newer CoordRippr', () => {
  assert.throws(
    () => unpackProjectFile({ app: 'CoordRippr', v: PROJECT_FILE_VERSION + 1, snapshot: {} }),
    /newer CoordRippr/
  );
});

test('unpackProjectFile drops malformed PDF entries rather than throwing', () => {
  const restored = unpackProjectFile({
    app: 'CoordRippr', v: 1, snapshot: sampleSnapshot(),
    pdfs: [null, { fileId: 'f1' }, { b64: 'AAAA' }, { fileId: 'f2', b64: 'AAAA' }],
  });
  assert.equal(restored.pdfs.length, 1);
  assert.equal(restored.pdfs[0].fileId, 'f2');
  assert.equal(restored.pdfs[0].name, 'f2.pdf'); // a name is invented when missing
});

test('an unnamed project still gets a name', () => {
  assert.equal(unpackProjectFile(packProjectFile({ project: null, snapshot: {} })).name, 'Imported project');
  assert.equal(unpackProjectFile(packProjectFile({ project: {}, snapshot: {} })).name, 'Imported project');
});

test('uniqueProjectName never collides with an existing project', () => {
  const existing = [{ name: 'Xantho' }, { name: 'Xantho (2)' }, { name: 'Other' }];
  assert.equal(uniqueProjectName('Fresh', existing), 'Fresh');
  assert.equal(uniqueProjectName('Xantho', existing), 'Xantho (3)');
  assert.equal(uniqueProjectName('Other', existing), 'Other (2)');
  assert.equal(uniqueProjectName('  ', existing), 'Imported project');
  assert.equal(uniqueProjectName(null, []), 'Imported project');
});

test('projectFileName is safe to hand to a save dialog', () => {
  assert.equal(projectFileName('Xantho'), `Xantho.${PROJECT_FILE_EXT}`);
  assert.equal(projectFileName('a/b:c*d'), `a-b-c-d.${PROJECT_FILE_EXT}`);
  assert.equal(projectFileName(''), `project.${PROJECT_FILE_EXT}`);
  assert.equal(projectFileName('   '), `project.${PROJECT_FILE_EXT}`);
  assert.ok(projectFileName('x'.repeat(300)).length < 80);
});

test('the size estimate accounts for base64 inflation', () => {
  // 3 bytes of PDF cost 4 characters of base64.
  assert.ok(estimateExportSize(0, 3_000_000) > 4_000_000);
  assert.ok(estimateExportSize(0, 3_000_000) < 4_100_000);
  // Snapshot text is carried through as-is.
  assert.ok(estimateExportSize(5000, 0) >= 5000);
});

test('formatBytes reads like a file manager', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(150 * 1024 * 1024), '150 MB');
});

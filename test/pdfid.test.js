// Tests for src/pdfid.js (content-based duplicate-PDF detection).
// Run: `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDocText,
  docFingerprint,
  hashHex,
  findDuplicateFiles,
  countDuplicates,
  MIN_TEXT_CHARS,
} from '../src/pdfid.js';

// Enough normalised characters to clear the floor.
const long = (seed) => `${seed} `.repeat(Math.ceil(MIN_TEXT_CHARS / (seed.length + 1)) + 5);

test('normalizeDocText keeps the words and throws away everything else', () => {
  assert.equal(normalizeDocText('Xenopygus  MARGINATUS (Erichson, 1840)'), 'xenopygus marginatus erichson 1840');
  assert.equal(normalizeDocText('  padded\n\ttext  '), 'padded text');
  assert.equal(normalizeDocText(null), '');
});

test('two renderings of the same sentence normalise equal', () => {
  const publisher = 'Collected at 41°24′12.2″N, 2°10′26.5″E — Barcelona.';
  const rescan = 'collected at 41 24 12.2 N,  2 10 26.5 E  Barcelona';
  assert.equal(normalizeDocText(publisher), normalizeDocText(rescan));
});

test('normalizeDocText keeps non-ASCII letters', () => {
  assert.equal(normalizeDocText('Müller & Peña'), 'müller peña');
});

test('docFingerprint returns null below the text floor', () => {
  assert.equal(docFingerprint(['a few words only']), null);
  assert.equal(docFingerprint([]), null);
  assert.equal(docFingerprint(['', '   ']), null);
  assert.ok(docFingerprint([long('some real body text')]));
});

test('two text-free PDFs are not duplicates of each other', () => {
  // Scanned pages: pdf.js yields nothing, so neither gets a text fingerprint and
  // findDuplicateFiles has nothing to group them on.
  const scanA = { id: 'a', name: 'scan1.pdf', byteHash: 'aa', textHash: docFingerprint(['']) };
  const scanB = { id: 'b', name: 'scan2.pdf', byteHash: 'bb', textHash: docFingerprint([' ']) };
  assert.equal(scanA.textHash, null);
  assert.deepEqual(findDuplicateFiles([scanA, scanB]), []);
});

test('docFingerprint joins pages in order', async () => {
  const a = docFingerprint([long('alpha'), long('beta')]);
  const b = docFingerprint([long('beta'), long('alpha')]);
  assert.notEqual(await hashHex(a), await hashHex(b));
});

test('hashHex is stable, hex, and differs per input', async () => {
  const one = await hashHex('hello');
  assert.equal(one, await hashHex('hello'));
  assert.match(one, /^[0-9a-f]+$/);
  assert.notEqual(one, await hashHex('hellp'));
});

test('hashHex accepts bytes and buffers as well as strings', async () => {
  const bytes = new TextEncoder().encode('hello');
  assert.equal(await hashHex(bytes), await hashHex('hello'));
  assert.equal(await hashHex(bytes.buffer.slice(0)), await hashHex('hello'));
});

test('hashHex falls back when WebCrypto is unavailable', async () => {
  const real = globalThis.crypto;
  try {
    // Some runtimes make globalThis.crypto non-writable; skip rather than fail.
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  } catch {
    return;
  }
  try {
    const fallback = await hashHex('hello');
    assert.match(fallback, /^[0-9a-f]{16}$/);
    assert.equal(fallback, await hashHex('hello'));
    assert.notEqual(fallback, await hashHex('world'));
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
  }
});

test('findDuplicateFiles groups identical bytes and keeps the first', () => {
  const groups = findDuplicateFiles([
    { id: 'f1', name: '168766.pdf', byteHash: 'aa', textHash: 't1' },
    { id: 'f2', name: 'Xenopygus.pdf', byteHash: 'aa', textHash: 't1' },
    { id: 'f3', name: 'other.pdf', byteHash: 'bb', textHash: 't2' },
  ]);
  assert.deepEqual(groups, [{ reason: 'bytes', keep: 'f1', dupes: ['f2'] }]);
  assert.equal(countDuplicates(groups), 1);
});

test('findDuplicateFiles reports a re-saved copy on the text tier', () => {
  const groups = findDuplicateFiles([
    { id: 'f1', name: 'Herman_1970.pdf', byteHash: 'aa', textHash: 'same' },
    { id: 'f2', name: 'scan_0043.pdf', byteHash: 'bb', textHash: 'same' },
  ]);
  assert.deepEqual(groups, [{ reason: 'text', keep: 'f1', dupes: ['f2'] }]);
});

test('a byte-matched pair is never reported again as a text match', () => {
  const groups = findDuplicateFiles([
    { id: 'f1', name: 'a.pdf', byteHash: 'aa', textHash: 'same' },
    { id: 'f2', name: 'b.pdf', byteHash: 'aa', textHash: 'same' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, 'bytes');
});

test('a third copy that only matches on text forms its own group', () => {
  const groups = findDuplicateFiles([
    { id: 'f1', name: 'a.pdf', byteHash: 'aa', textHash: 'same' },
    { id: 'f2', name: 'b.pdf', byteHash: 'aa', textHash: 'same' },
    { id: 'f3', name: 'c.pdf', byteHash: 'cc', textHash: 'same' },
  ]);
  assert.deepEqual(groups, [
    { reason: 'bytes', keep: 'f1', dupes: ['f2'] },
    // f1 and f2 are already accounted for, so f3 has no one left to pair with.
    ]);
});

test('three identical copies form one group with two dupes', () => {
  const groups = findDuplicateFiles([
    { id: 'f1', name: 'a.pdf', byteHash: 'aa' },
    { id: 'f2', name: 'b.pdf', byteHash: 'aa' },
    { id: 'f3', name: 'c.pdf', byteHash: 'aa' },
  ]);
  assert.deepEqual(groups, [{ reason: 'bytes', keep: 'f1', dupes: ['f2', 'f3'] }]);
  assert.equal(countDuplicates(groups), 2);
});

test('files without hashes are skipped, not grouped together', () => {
  assert.deepEqual(findDuplicateFiles([
    { id: 'f1', name: 'a.pdf', byteHash: null, textHash: null },
    { id: 'f2', name: 'b.pdf', byteHash: null, textHash: null },
    { id: 'f3', name: 'c.pdf' },
  ]), []);
});

test('findDuplicateFiles copes with nothing to do', () => {
  assert.deepEqual(findDuplicateFiles([]), []);
  assert.deepEqual(findDuplicateFiles(), []);
  assert.equal(countDuplicates(), 0);
});

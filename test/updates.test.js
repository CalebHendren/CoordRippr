// Tests for src/updates.js (version parsing / update-due logic). No need to run
// unless you changed updates.js. Prereq: `npm install`. Run: `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, isNewer, isDue, CHECK_INTERVAL_MS } from '../src/updates.js';

test('parseVersion', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('0.1.0'), [0, 1, 0]);
  assert.deepEqual(parseVersion('v2.0.0-beta.1'), [2, 0, 0]);
  assert.deepEqual(parseVersion('v3'), [3, 0, 0]);
  assert.equal(parseVersion('nope'), null);
});

test('isNewer', () => {
  assert.equal(isNewer('v0.2.0', '0.1.0'), true);
  assert.equal(isNewer('v0.1.0', '0.1.0'), false);
  assert.equal(isNewer('v0.1.0', '0.2.0'), false);
  assert.equal(isNewer('v1.0.0', '0.9.9'), true);
  assert.equal(isNewer('v0.1.1', '0.1.0'), true);
  assert.equal(isNewer('garbage', '0.1.0'), false);
});

test('isDue', () => {
  const now = 1_800_000_000_000;
  assert.equal(isDue(null, now), true);
  assert.equal(isDue(undefined, now), true);
  assert.equal(isDue('not a number', now), true);
  assert.equal(isDue(now - CHECK_INTERVAL_MS - 1, now), true);
  assert.equal(isDue(now - 1000, now), false);
});

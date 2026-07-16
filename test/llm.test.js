// Tests for src/llm.js (providers, request/response wire formats, prompt
// building, chunking, runPool). No need to run unless you changed llm.js.
// Prereq: `npm install`. Run: `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS,
  buildRequest,
  extractText,
  parseResultsJson,
  normalizeResult,
  buildPrompt,
  chunkWork,
  chunkPerPage,
  runPool,
  runBatched,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  MAX_BATCH_DELAY_MS,
  MAX_ROWS_PER_CHUNK,
} from '../src/llm.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('anthropic request shape', () => {
  const req = buildRequest({
    kind: 'anthropic',
    url: PROVIDERS.anthropic.url,
    model: 'claude-opus-4-8',
    apiKey: 'sk-ant-test',
    system: 'SYS',
    user: 'USER',
  });
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['x-api-key'], 'sk-ant-test');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.headers['anthropic-dangerous-direct-browser-access'], undefined);
  const body = JSON.parse(req.body);
  assert.equal(body.model, 'claude-opus-4-8');
  assert.equal(body.system, 'SYS');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'USER' }]);
  assert.ok(body.max_tokens > 0);
  assert.equal(body.temperature, undefined); // rejected by current Opus models
});

test('anthropic browser request adds CORS opt-in header', () => {
  const req = buildRequest({
    kind: 'anthropic', url: PROVIDERS.anthropic.url, model: 'm', apiKey: 'k',
    system: 's', user: 'u', browser: true,
  });
  assert.equal(req.headers['anthropic-dangerous-direct-browser-access'], 'true');
});

test('openai-compatible request shape (covers Chinese providers)', () => {
  for (const id of ['openai', 'gemini', 'deepseek', 'qwen', 'kimi', 'zhipu']) {
    const p = PROVIDERS[id];
    const req = buildRequest({
      kind: p.kind, url: p.url, model: p.model, apiKey: 'KEY', system: 'S', user: 'U',
    });
    assert.equal(req.headers.authorization, 'Bearer KEY', id);
    const body = JSON.parse(req.body);
    assert.equal(body.messages[0].role, 'system', id);
    assert.equal(body.messages[1].role, 'user', id);
  }
});

test('custom endpoint without key omits auth header', () => {
  const req = buildRequest({
    kind: 'openai', url: 'https://localhost:1234/v1/chat/completions',
    model: 'local', apiKey: '', system: 's', user: 'u',
  });
  assert.equal(req.headers.authorization, undefined);
});

test('extractText anthropic', () => {
  const text = extractText('anthropic', JSON.stringify({
    content: [{ type: 'text', text: '[]' }], stop_reason: 'end_turn',
  }));
  assert.equal(text, '[]');
  assert.throws(() => extractText('anthropic', JSON.stringify({
    type: 'error', error: { message: 'bad key' },
  })), /bad key/);
  assert.throws(() => extractText('anthropic', JSON.stringify({
    content: [], stop_reason: 'refusal',
  })), /declined/);
});

test('extractText openai-compatible', () => {
  const text = extractText('openai', JSON.stringify({
    choices: [{ message: { content: 'hello' } }],
  }));
  assert.equal(text, 'hello');
  assert.throws(() => extractText('openai', JSON.stringify({
    error: { message: 'invalid api key' },
  })), /invalid api key/);
  assert.throws(() => extractText('openai', 'Bad Gateway'), /non-JSON/);
});

test('parseResultsJson handles fences and prose', () => {
  const arr = [{ row: 'r1', verdict: 'ok' }];
  assert.deepEqual(parseResultsJson(JSON.stringify(arr)), arr);
  assert.deepEqual(parseResultsJson('```json\n' + JSON.stringify(arr) + '\n```'), arr);
  assert.deepEqual(parseResultsJson('Here are the results:\n' + JSON.stringify(arr) + '\nDone!'), arr);
  assert.deepEqual(parseResultsJson('no json here'), []);
  assert.deepEqual(parseResultsJson('[{"row": "r1", "note": "bracket ] in string"}]')[0].row, 'r1');
});

test('normalizeResult validates fields', () => {
  const r = normalizeResult({ row: 'r5', verdict: 'mismatch', lat: 41.4, lon: 2.17, col1: ' Fox ', col2: 'red', note: 'n' });
  assert.equal(r.verdict, 'mismatch');
  assert.deepEqual(r.cols, ['Fox', 'red']);
  assert.equal(normalizeResult({ verdict: 'ok' }), null); // no row id
  assert.equal(normalizeResult({ row: 'r1', verdict: 'nonsense', lat: 999 }).verdict, null);
  assert.equal(normalizeResult({ row: 'r1', lat: 999 }).lat, null); // out of range
});

test('normalizeResult reads as many colN fields as asked', () => {
  const r = normalizeResult({ row: 'r1', col1: 'a', col2: 'b', col3: ' c ', col4: 7 }, 4);
  assert.deepEqual(r.cols, ['a', 'b', 'c', '']); // non-strings become ""
  assert.deepEqual(normalizeResult({ row: 'r1', col1: 'a', col2: 'b', col3: 'ignored' }).cols, ['a', 'b']);
});

test('normalizeResult only honours a literal delete: true', () => {
  assert.equal(normalizeResult({ row: 'r1', delete: true }).del, true);
  assert.equal(normalizeResult({ row: 'r1', delete: false }).del, false);
  assert.equal(normalizeResult({ row: 'r1', delete: 'yes' }).del, false);
  assert.equal(normalizeResult({ row: 'r1' }).del, false);
});

test('normalizeResult only honours a literal need_prev: true, and reads notes_col', () => {
  assert.equal(normalizeResult({ row: 'r1', need_prev: true }).needPrev, true);
  assert.equal(normalizeResult({ row: 'r1', need_prev: 'yes' }).needPrev, false);
  assert.equal(normalizeResult({ row: 'r1' }).needPrev, false);
  assert.equal(normalizeResult({ row: 'r1', notes_col: ' shady creek ' }).notesCol, 'shady creek');
  assert.equal(normalizeResult({ row: 'r1' }).notesCol, '');
});

test('normalizeResult only honours a literal need_next: true', () => {
  assert.equal(normalizeResult({ row: 'r1', need_next: true }).needNext, true);
  assert.equal(normalizeResult({ row: 'r1', need_next: 'yes' }).needNext, false);
  assert.equal(normalizeResult({ row: 'r1' }).needNext, false);
});

test('buildPrompt includes rows, column names and page markers', () => {
  const { system, user } = buildPrompt({
    rows: [{ id: 'r1', num: 1, cells: ['', ''], lat: 41.4, lon: 2.17, file: 'a.pdf', page: 3 }],
    pages: [{ file: 'a.pdf', page: 3, text: 'The fox at 41.4, 2.17 was red.' }],
    cols: ['Animal', 'Color'],
    extra: 'Focus on mammals.',
    verify: true,
    fill: true,
  });
  assert.match(system, /VERIFY/);
  assert.match(system, /FILL/);
  assert.match(system, /"Animal"/);
  assert.match(user, /r1 \| 1 \|/);
  assert.match(user, /--- a\.pdf — page 3 ---/);
  assert.match(user, /Focus on mammals\./);
});

test('buildPrompt scales the schema and fill task to N columns', () => {
  const { system, user } = buildPrompt({
    rows: [{ id: 'r1', num: 1, cells: ['x', 'y', 'z'], lat: 1, lon: 2, file: 'a.pdf', page: 1 }],
    pages: [{ file: 'a.pdf', page: 1, text: 't' }],
    cols: ['Site', 'Species', 'Depth'],
    extra: '', verify: false, fill: true,
  });
  assert.match(system, /"col1"/);
  assert.match(system, /"col3"/);
  assert.doesNotMatch(system, /"col4"/);
  assert.match(system, /"Depth"/);
  assert.match(user, /Site \| Species \| Depth/);
  assert.match(user, /x \| y \| z/);
});

test('buildPrompt omits task text when disabled', () => {
  const { system } = buildPrompt({
    rows: [], pages: [], cols: ['A', 'B'], extra: '', verify: true, fill: false,
  });
  assert.match(system, /VERIFY/);
  assert.doesNotMatch(system, /FILL/);
  assert.doesNotMatch(system, /FLAG/);
  assert.doesNotMatch(system, /"delete"/);
  assert.doesNotMatch(system, /"need_prev"/);
  assert.doesNotMatch(system, /"notes_col"/);
});

test('buildPrompt adds the FLAG task and delete field when requested', () => {
  const { system } = buildPrompt({
    rows: [], pages: [], cols: ['A', 'B'], extra: '',
    verify: false, fill: false, flagDelete: true,
  });
  assert.match(system, /FLAG false positives/);
  assert.match(system, /"delete": true\|false/);
  assert.match(system, /when in doubt, keep it/);
});

test('buildPrompt offers need_prev whenever allowPrev is on (independent of fill)', () => {
  const on = buildPrompt({
    rows: [], pages: [], cols: ['A', 'B'], extra: '',
    verify: false, fill: true, allowPrev: true,
  });
  assert.match(on.system, /"need_prev": true\|false/);
  assert.match(on.system, /preceding page/);
  // Page flips are available even when FILL is off — e.g. driven only by the
  // user's "Add to the prompt" instructions.
  const fillOff = buildPrompt({
    rows: [], pages: [], cols: ['A', 'B'], extra: 'Extract the genus and species.',
    verify: false, fill: false, allowPrev: true,
  });
  assert.match(fillOff.system, /"need_prev": true\|false/);
  assert.match(fillOff.system, /preceding page/);
  assert.match(fillOff.system, /added instructions/);
  const off = buildPrompt({
    rows: [], pages: [], cols: ['A', 'B'], extra: '',
    verify: false, fill: true, allowPrev: false,
  });
  assert.doesNotMatch(off.system, /"need_prev"/);
});

test('buildPrompt offers need_next whenever allowNext is on (independent of fill)', () => {
  const on = buildPrompt({
    rows: [], pages: [], cols: ['A', 'B'], extra: '',
    verify: false, fill: true, allowNext: true,
  });
  assert.match(on.system, /"need_next": true\|false/);
  assert.match(on.system, /following page/);
  // Available with FILL off too (extra-instruction driven).
  const fillOff = buildPrompt({
    rows: [], pages: [], cols: ['A', 'B'], extra: 'Extract the genus and species.',
    verify: false, fill: false, allowNext: true,
  });
  assert.match(fillOff.system, /"need_next": true\|false/);
  assert.match(fillOff.system, /following page/);
  const off = buildPrompt({
    rows: [], pages: [], cols: ['A', 'B'], extra: '',
    verify: false, fill: true, allowNext: false,
  });
  assert.doesNotMatch(off.system, /"need_next"/);
});

test('buildPrompt adds the NOTES task with the user spec', () => {
  const { system } = buildPrompt({
    rows: [], pages: [], cols: ['A', 'B'], extra: '',
    verify: false, fill: false, notes: true, notesSpec: 'the habitat near each coordinate',
  });
  assert.match(system, /NOTES/);
  assert.match(system, /"notes_col": "<string>"/);
  assert.match(system, /the habitat near each coordinate/);
});

test('chunkWork splits by budget and keeps rows with their pages', () => {
  const pages = [
    { file: 'f', page: 1, text: 'x'.repeat(900) },
    { file: 'f', page: 2, text: 'y'.repeat(900) },
    { file: 'f', page: 3, text: 'z'.repeat(900) },
  ];
  const rows = [
    { id: 'r1', page: 1 },
    { id: 'r2', page: 3 },
    { id: 'r3', page: 3 },
  ];
  const chunks = chunkWork(pages, rows, 2000);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].rows.map((r) => r.id), ['r1']);
  assert.deepEqual(chunks[1].rows.map((r) => r.id), ['r2', 'r3']);
  // pages without rows are context in chunk 0 (page 2 rode along)
  assert.equal(chunks[0].pages.length, 2);
});

test('chunkWork drops rowless chunks and truncates oversized pages', () => {
  const pages = [
    { file: 'f', page: 1, text: 'a'.repeat(5000) },
    { file: 'f', page: 2, text: 'context only' },
  ];
  const rows = [{ id: 'r1', page: 1 }];
  const chunks = chunkWork(pages, rows, 1000);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].pages[0].text.includes('truncated'));
});

test('chunkPerPage sends each page alone with only its own rows', () => {
  const pages = [
    { file: 'f', page: 5, text: 'five' },
    { file: 'f', page: 7, text: 'seven' },
    { file: 'f', page: 9, text: 'nine (no rows)' },
  ];
  const rows = [
    { id: 'r1', page: 7 },
    { id: 'r2', page: 7 },
    { id: 'r3', page: 5 },
  ];
  const chunks = chunkPerPage(pages, rows);
  assert.equal(chunks.length, 2); // page 9 has no rows -> skipped
  assert.equal(chunks[0].pages.length, 1);
  assert.equal(chunks[0].pages[0].page, 5);
  assert.deepEqual(chunks[0].rows.map((r) => r.id), ['r3']);
  assert.equal(chunks[1].pages[0].page, 7);
  assert.deepEqual(chunks[1].rows.map((r) => r.id), ['r1', 'r2']);
});

test('chunkPerPage truncates huge pages and splits over-full row sets', () => {
  const rows = Array.from({ length: MAX_ROWS_PER_CHUNK + 5 }, (_, i) => ({ id: `r${i}`, page: 1 }));
  const chunks = chunkPerPage([{ file: 'f', page: 1, text: 'x'.repeat(5000) }], rows, 1000);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].rows.length, MAX_ROWS_PER_CHUNK);
  assert.equal(chunks[1].rows.length, 5);
  assert.ok(chunks[0].pages[0].text.includes('truncated'));
});

test('runPool returns results in item order regardless of completion order', async () => {
  const items = [30, 5, 20, 1, 15];
  const out = await runPool(items, 3, async (ms, i) => {
    await tick(ms); // later items finish first
    return `${i}:${ms}`;
  });
  assert.deepEqual(out, ['0:30', '1:5', '2:20', '3:1', '4:15']);
});

test('runPool never exceeds the concurrency limit', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  await runPool(items, 4, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await tick(5);
    inFlight--;
  });
  assert.equal(peak, 4);
});

test('runPool with limit 1 is fully sequential (old behaviour)', async () => {
  const order = [];
  let inFlight = 0;
  let peak = 0;
  await runPool([1, 2, 3], 1, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await tick(2);
    order.push(n);
    inFlight--;
  });
  assert.equal(peak, 1);
  assert.deepEqual(order, [1, 2, 3]);
});

test('runPool clamps a limit larger than the item count', async () => {
  let inFlight = 0;
  let peak = 0;
  await runPool([1, 2], 99, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await tick(3);
    inFlight--;
  });
  assert.equal(peak, 2); // only 2 items, so at most 2 run at once
});

test('runPool coerces a bad limit to at least one worker', async () => {
  const seen = [];
  await runPool([1, 2, 3], 0, async (n) => { seen.push(n); await tick(1); });
  assert.deepEqual(seen, [1, 2, 3]);
  const seen2 = [];
  await runPool([1, 2], NaN, async (n) => { seen2.push(n); });
  assert.deepEqual(seen2, [1, 2]);
});

test('runPool stops picking up new items once shouldStop() is true', async () => {
  const started = [];
  let stop = false;
  const out = await runPool([1, 2, 3, 4, 5, 6], 1, async (n) => {
    started.push(n);
    if (n === 2) stop = true; // request a stop from inside the pool
    await tick(1);
    return n * 10;
  }, () => stop);
  // Items 1 and 2 start; after 2 sets stop, 3+ are never picked up.
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(out.slice(0, 2), [10, 20]);
  assert.equal(out[2], undefined); // untouched slots stay undefined
});

test('runPool handles an empty item list', async () => {
  const out = await runPool([], 4, async () => { throw new Error('should not run'); });
  assert.deepEqual(out, []);
});

test('runBatched returns results in item order regardless of completion order', async () => {
  const items = [30, 5, 20, 1, 15];
  const out = await runBatched(items, 2, 3, async (ms, i) => {
    await tick(ms); // later items finish first
    return `${i}:${ms}`;
  });
  assert.deepEqual(out, ['0:30', '1:5', '2:20', '3:1', '4:15']);
});

test('runBatched starts each batch on the clock without waiting for the last to finish', async () => {
  const started = [];
  let release;
  const gate = new Promise((r) => { release = r; }); // workers hang until released
  const sleeps = [];
  const sleep = (ms) => { sleeps.push(ms); return Promise.resolve(); }; // instant, records the gap
  const p = runBatched([0, 1, 2, 3, 4, 5], 2, 250, async (v, i) => {
    started.push(i);
    await gate; // never resolves until we release, below
    return v * 10;
  }, () => false, sleep);
  // The dispatch loop is microtask-driven here (instant sleep), so a macrotask
  // turn is enough for every batch to have been launched.
  await tick(0);
  await tick(0);
  // All six started though not one worker has resolved — batches fire on the
  // clock, not on completion.
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(sleeps, [250, 250]); // two gaps between three batches
  release();
  assert.deepEqual(await p, [0, 10, 20, 30, 40, 50]);
});

test('runBatched groups items into fixed-size batches', async () => {
  const batches = [];
  const sleep = () => { batches.push('gap'); return Promise.resolve(); };
  let cur = [];
  await runBatched([1, 2, 3, 4, 5], 2, 10, async (n) => {
    cur.push(n);
  }, () => false, sleep);
  // 5 items, size 2 -> batches [1,2] [3,4] [5]; two gaps between them.
  assert.equal(batches.length, 2);
  assert.deepEqual(cur, [1, 2, 3, 4, 5]);
});

test('runBatched stops launching new batches once shouldStop() is true', async () => {
  const started = [];
  let stop = false;
  const sleep = () => Promise.resolve();
  const out = await runBatched([1, 2, 3, 4, 5, 6], 2, 100, async (n) => {
    started.push(n);
    if (n === 2) stop = true; // request a stop from inside the first batch
    return n * 10;
  }, () => stop, sleep);
  // First batch (1,2) starts; shouldStop is polled before batch 2, so 3+ never start.
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(out.slice(0, 2), [10, 20]);
  assert.equal(out[2], undefined); // untouched slots stay undefined
});

test('runBatched surfaces a worker error and stops launching later batches', async () => {
  const started = [];
  // A real (tiny) delay lets the rejection propagate before the next batch.
  await assert.rejects(
    runBatched([1, 2, 3, 4], 2, 5, async (n) => {
      started.push(n);
      if (n === 1) throw new Error('boom');
    }, () => false),
    /boom/
  );
  assert.deepEqual(started, [1, 2]); // batch 2 (3,4) never launches
});

test('runBatched coerces a bad size to one worker and a bad delay to no wait', async () => {
  const seen = [];
  const sleeps = [];
  const sleep = (ms) => { sleeps.push(ms); return Promise.resolve(); };
  await runBatched([1, 2, 3], 0, -50, async (n) => { seen.push(n); }, () => false, sleep);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(sleeps, []); // delay coerced to 0 -> never sleeps
});

test('runBatched handles an empty item list', async () => {
  const out = await runBatched([], 4, 100, async () => { throw new Error('should not run'); });
  assert.deepEqual(out, []);
});

test('concurrency and pacing constants are sane', () => {
  assert.ok(DEFAULT_CONCURRENCY >= 1 && DEFAULT_CONCURRENCY <= MAX_CONCURRENCY);
  assert.ok(MAX_CONCURRENCY >= 1);
  assert.ok(MAX_BATCH_DELAY_MS > 0);
});

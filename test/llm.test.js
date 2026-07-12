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
  MAX_ROWS_PER_CHUNK,
} from '../src/llm.js';

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

test('buildPrompt offers need_prev only when fill and allowPrev are on', () => {
  const on = buildPrompt({
    rows: [], pages: [], cols: ['A', 'B'], extra: '',
    verify: false, fill: true, allowPrev: true,
  });
  assert.match(on.system, /"need_prev": true\|false/);
  assert.match(on.system, /preceding page/);
  const off = buildPrompt({
    rows: [], pages: [], cols: ['A', 'B'], extra: '',
    verify: false, fill: true, allowPrev: false,
  });
  assert.doesNotMatch(off.system, /"need_prev"/);
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

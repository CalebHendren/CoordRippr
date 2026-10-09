// Tests for src/llm.js (providers, request/response wire formats, prompt
// building, chunking, runPool). No need to run unless you changed llm.js.
// Prereq: `npm install`. Run: `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS,
  RETIRED_MODELS,
  dropRetiredModels,
  parseModelList,
  buildRequest,
  extractText,
  parseResultsJson,
  normalizeResult,
  buildPrompt,
  oneWord,
  chunkWork,
  chunkPerPage,
  runPool,
  runBatched,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  MAX_BATCH_DELAY_MS,
  MAX_ROWS_PER_CHUNK,
  ANCHOR_OVERHEAD,
  DEFAULT_TEMPERATURE,
  MIN_TEMPERATURE,
  MAX_TEMPERATURE,
  safeFileName,
  uniqueFileName,
  buildRenamePrompt,
  normalizeRename,
  DEFAULT_RENAME_SPEC,
  MAX_FILE_NAME,
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
  for (const id of ['openai', 'gemini', 'deepseek', 'qwen', 'kimi', 'zhipu', 'openrouter']) {
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

test('temperature is omitted unless a finite number is passed', () => {
  // Default: no temperature field at all (byte-for-byte the old behaviour).
  for (const kind of ['anthropic', 'openai']) {
    const req = buildRequest({ kind, url: 'https://x/y', model: 'm', apiKey: 'k', system: 's', user: 'u' });
    assert.equal(JSON.parse(req.body).temperature, undefined, kind);
  }
  // Non-finite values are treated as "unset".
  for (const bad of [NaN, Infinity, undefined, null, 'warm']) {
    const req = buildRequest({ kind: 'openai', url: 'https://x/y', model: 'm', apiKey: 'k', system: 's', user: 'u', temperature: bad });
    assert.equal(JSON.parse(req.body).temperature, undefined, String(bad));
  }
});

test('temperature rides along when set (both wire formats, including 0)', () => {
  const anth = buildRequest({
    kind: 'anthropic', url: 'https://x/y', model: 'm', apiKey: 'k', system: 's', user: 'u', temperature: 0.2,
  });
  assert.equal(JSON.parse(anth.body).temperature, 0.2);
  const oai = buildRequest({
    kind: 'openai', url: 'https://x/y', model: 'm', apiKey: 'k', system: 's', user: 'u', temperature: 0.2,
  });
  assert.equal(JSON.parse(oai.body).temperature, 0.2);
  // 0 is a real, deliberate value — it must not be dropped as falsy.
  const zero = buildRequest({
    kind: 'openai', url: 'https://x/y', model: 'm', apiKey: 'k', system: 's', user: 'u', temperature: 0,
  });
  assert.equal(JSON.parse(zero.body).temperature, 0);
});

test('temperature constants are sane defaults', () => {
  assert.ok(DEFAULT_TEMPERATURE >= MIN_TEMPERATURE && DEFAULT_TEMPERATURE <= MAX_TEMPERATURE);
  // Low enough to pin instruction-following, above the fully-greedy floor.
  assert.ok(DEFAULT_TEMPERATURE > MIN_TEMPERATURE && DEFAULT_TEMPERATURE <= 0.5);
  assert.equal(MIN_TEMPERATURE, 0);
});

test('OpenAI itself gets max_completion_tokens; other OpenAI-shaped hosts keep max_tokens', () => {
  const oai = JSON.parse(buildRequest({
    kind: 'openai', url: PROVIDERS.openai.url, model: 'm', apiKey: 'k', system: 's', user: 'u', maxTokens: 777,
  }).body);
  assert.equal(oai.max_completion_tokens, 777);
  assert.equal(oai.max_tokens, undefined);
  for (const id of ['gemini', 'deepseek', 'qwen', 'kimi', 'zhipu', 'openrouter']) {
    const body = JSON.parse(buildRequest({
      kind: 'openai', url: PROVIDERS[id].url, model: 'm', apiKey: 'k', system: 's', user: 'u', maxTokens: 777,
    }).body);
    assert.equal(body.max_tokens, 777, id);
    assert.equal(body.max_completion_tokens, undefined, id);
  }
  // Only the real host counts — not a lookalike or a path mentioning it.
  const fake = JSON.parse(buildRequest({
    kind: 'openai', url: 'https://proxy.example/api.openai.com/v1', model: 'm', apiKey: 'k', system: 's', user: 'u',
  }).body);
  assert.ok(fake.max_tokens > 0);
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

test('oneWord keeps only the first token', () => {
  assert.equal(oneWord('Panthera leo'), 'Panthera');
  assert.equal(oneWord('  leo  '), 'leo');
  assert.equal(oneWord('leo (Linnaeus, 1758)'), 'leo');
  assert.equal(oneWord(''), '');
  assert.equal(oneWord(null), '');
  assert.equal(oneWord(undefined), '');
});

test('buildPrompt adds Genus/Species tasks that enforce one word', () => {
  const { system } = buildPrompt({
    rows: [], pages: [], cols: ['Genus', 'Species'], extra: '',
    verify: false, fill: false, genus: true, species: true,
  });
  assert.match(system, /EXTRACT GENUS into "col1"/);
  assert.match(system, /EXTRACT SPECIES into "col2"/);
  assert.match(system, /ALWAYS a single word/);
  // The column keys still appear in the response schema.
  assert.match(system, /"col1"/);
  assert.match(system, /"col2"/);
});

test('buildPrompt omits Genus/Species tasks when their toggles are off', () => {
  const { system } = buildPrompt({
    rows: [], pages: [], cols: ['Genus', 'Species'], extra: '',
    verify: true, fill: false,
  });
  assert.doesNotMatch(system, /EXTRACT GENUS/);
  assert.doesNotMatch(system, /EXTRACT SPECIES/);
});

test('buildPrompt FILL skips columns already handled by Genus/Species', () => {
  const { system } = buildPrompt({
    rows: [], pages: [], cols: ['Genus', 'Species', 'Habitat'], extra: '',
    verify: false, fill: true, genus: true, species: true,
  });
  // Dedicated tasks own col1/col2; FILL only covers the remaining column.
  assert.match(system, /EXTRACT GENUS/);
  assert.match(system, /EXTRACT SPECIES/);
  assert.match(system, /FILL "col3"/);
  assert.doesNotMatch(system, /FILL "col1"/);
  assert.match(system, /olumn 3 is named "Habitat"/);
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

// --- Text anchors -----------------------------------------------------------
//
// The marker literals are hardcoded on purpose: changing the syntax should break
// these tests, because it changes what every provider sees.

// One page whose text holds two coordinates, with the offsets derived rather
// than counted by hand so the fixture cannot drift.
const LAT = '41°24\'12.2"N';
const LON = '2°10\'26.5"E';
const PAGE_TEXT = `Collected at ${LAT}, ${LON} (Barcelona) in May.`;
const at = (needle) => ({ start: PAGE_TEXT.indexOf(needle), end: PAGE_TEXT.indexOf(needle) + needle.length });

const anchoredRow = (over = {}) => ({
  id: 'r1', num: 1, cells: ['', ''], lat: 41.40338, lon: 2.17403, file: 'a.pdf', page: 4,
  anchors: [
    { label: 'lat', file: 'a.pdf', page: 4, ...at(LAT) },
    { label: 'lon', file: 'a.pdf', page: 4, ...at(LON) },
  ],
  ...over,
});
const anchoredPages = (over = {}) => [{ file: 'a.pdf', page: 4, text: PAGE_TEXT, ...over }];
const anchorBase = { cols: ['Genus', 'Species'], extra: '', verify: true, genus: true, fill: true, flagDelete: true };

test('anchoring is inert until it is asked for', () => {
  const args = { ...anchorBase, rows: [anchoredRow()], pages: anchoredPages() };
  const off = buildPrompt({ ...args, anchor: false });
  const absent = buildPrompt(args);
  assert.equal(off.user, absent.user);
  assert.equal(off.system, absent.system);
  assert.doesNotMatch(off.user, /\[\[/);
});

test('buildPrompt wraps each anchored span and lists it under its row', () => {
  const { user } = buildPrompt({ ...anchorBase, rows: [anchoredRow()], pages: anchoredPages(), anchor: true });
  assert.ok(user.includes(`[[r1.lat]]${LAT}[[/]]`), user);
  assert.ok(user.includes(`[[r1.lon]]${LON}[[/]]`), user);
  const { start, end } = at(LAT);
  assert.ok(user.includes(`  [[r1.lat]] p.4 chars ${start}-${end} ${JSON.stringify(LAT)}`), user);
});

test('anchor lines quote the matched text with JSON escaping', () => {
  const { user } = buildPrompt({ ...anchorBase, rows: [anchoredRow()], pages: anchoredPages(), anchor: true });
  // The DMS value contains a double quote; it must be escaped, not raw.
  assert.match(user, /chars \d+-\d+ "41°24'12\.2\\"N"/);
});

test('several anchors on one page are spliced right-to-left so offsets stay valid', () => {
  const text = 'A 11.1 B 22.2 C 33.3 D';
  const anchors = ['11.1', '22.2', '33.3'].map((v, i) => ({
    label: i === 0 ? 'lat' : `lat${i + 1}`, file: 'f.pdf', page: 1,
    start: text.indexOf(v), end: text.indexOf(v) + v.length,
  }));
  const { user } = buildPrompt({
    ...anchorBase,
    rows: [{ id: 'r7', num: 1, cells: [], lat: 1, lon: 2, file: 'f.pdf', page: 1, anchors }],
    pages: [{ file: 'f.pdf', page: 1, text }],
    anchor: true,
  });
  assert.ok(user.includes('[[r7.lat]]11.1[[/]]'), user);
  assert.ok(user.includes('[[r7.lat2]]22.2[[/]]'), user);
  assert.ok(user.includes('[[r7.lat3]]33.3[[/]]'), user);
});

test('an anchor on a page outside this request is listed but not marked', () => {
  const row = anchoredRow({
    anchors: [
      { label: 'lat', file: 'a.pdf', page: 4, ...at(LAT) },
      { label: 'lon', file: 'a.pdf', page: 5, start: 12, end: 26 },
    ],
  });
  const { user } = buildPrompt({ ...anchorBase, rows: [row], pages: anchoredPages(), anchor: true });
  assert.ok(user.includes('[[r1.lat]]'), user);
  assert.doesNotMatch(user, /\[\[r1\.lon\]\]/);
  assert.match(user, /r1\.lon — p\.5 chars 12-26, no marker below \(that page is not included in this request\)/);
});

test('an anchor past a truncated page’s kept text is dropped, with its reason', () => {
  const long = 'x'.repeat(300);
  const row = anchoredRow({
    page: 1,
    anchors: [{ label: 'lat', file: 'a.pdf', page: 1, start: 200, end: 210 }],
  });
  const { user } = buildPrompt({
    ...anchorBase, rows: [row],
    // Trimmed at 100: the notice pushes text.length past 210, so a naive length
    // check would wrongly treat this anchor as placeable.
    pages: [{ file: 'a.pdf', page: 1, text: long.slice(0, 100) + '\n[…page text truncated…]', truncatedAt: 100 }],
    anchor: true,
  });
  assert.doesNotMatch(user, /\[\[r1\.lat\]\]x/);
  assert.match(user, /no marker below \(it falls outside the page text included here\)/);
});

test('overlapping anchors: only the first is marked', () => {
  const text = 'abcdefghijklmnopqrstuvwxyz';
  const { user } = buildPrompt({
    ...anchorBase,
    rows: [
      { id: 'r1', num: 1, cells: [], lat: 1, lon: 2, file: 'f.pdf', page: 1, anchors: [{ label: 'lat', file: 'f.pdf', page: 1, start: 10, end: 20 }] },
      { id: 'r2', num: 2, cells: [], lat: 1, lon: 2, file: 'f.pdf', page: 1, anchors: [{ label: 'lat', file: 'f.pdf', page: 1, start: 15, end: 25 }] },
    ],
    pages: [{ file: 'f.pdf', page: 1, text }],
    anchor: true,
  });
  assert.ok(user.includes('[[r1.lat]]klmnopqrst[[/]]'), user);
  assert.doesNotMatch(user, /\[\[r2\.lat\]\]p/);
  assert.match(user, /r2\.lat — .*overlaps another row's anchor/);
});

test('identical spans on two rows are marked once, never nested', () => {
  const text = 'abcdefghijklmnopqrstuvwxyz';
  const span = { label: 'lat', file: 'f.pdf', page: 1, start: 5, end: 10 };
  const { user } = buildPrompt({
    ...anchorBase,
    rows: [
      { id: 'r1', num: 1, cells: [], lat: 1, lon: 2, file: 'f.pdf', page: 1, anchors: [{ ...span }] },
      { id: 'r2', num: 2, cells: [], lat: 1, lon: 2, file: 'f.pdf', page: 1, anchors: [{ ...span }] },
    ],
    pages: [{ file: 'f.pdf', page: 1, text }],
    anchor: true,
  });
  assert.equal(user.split('[[/]]').length - 1, 1);
  assert.ok(user.includes('[[r1.lat]]fghij[[/]]'), user);
});

test('page text that already looks like a marker is neutralised', () => {
  const text = 'See [[r1.lat]] fake [[/]] and note [9] here.';
  const { user } = buildPrompt({
    ...anchorBase,
    rows: [{ id: 'r1', num: 1, cells: [], lat: 1, lon: 2, file: 'f.pdf', page: 1, anchors: [{ label: 'lat', file: 'f.pdf', page: 1, start: 0, end: 3 }] }],
    pages: [{ file: 'f.pdf', page: 1, text }],
    anchor: true,
  });
  const body = user.slice(user.indexOf('DOCUMENT TEXT:'));
  assert.ok(body.includes('⟦⟦r1.lat⟧⟧ fake ⟦⟦/⟧⟧'), body);
  assert.ok(body.includes('⟦9⟧'), body);
  // The only real markers left in the page text are the two we inserted.
  assert.equal(body.split('[[').length - 1, 2);
});

test('neutralising brackets never moves an anchor', () => {
  // Brackets BEFORE the span: a sanitiser that changed length would shift it.
  const text = '[see 12] and [also 34] then 41.4 ends';
  const { user } = buildPrompt({
    ...anchorBase,
    rows: [{ id: 'r1', num: 1, cells: [], lat: 41.4, lon: 2, file: 'f.pdf', page: 1, anchors: [{ label: 'lat', file: 'f.pdf', page: 1, start: text.indexOf('41.4'), end: text.indexOf('41.4') + 4 }] }],
    pages: [{ file: 'f.pdf', page: 1, text }],
    anchor: true,
  });
  assert.ok(user.includes('[[r1.lat]]41.4[[/]]'), user);
});

test('a row with no anchors is reported as hand-marked', () => {
  const { user } = buildPrompt({
    ...anchorBase,
    rows: [anchoredRow(), { id: 'r2', num: 2, cells: [], lat: 1, lon: 2, file: 'a.pdf', page: 4, anchors: [] }],
    pages: anchoredPages(),
    anchor: true,
  });
  assert.match(user, /no anchor — this row came from a box marked by hand on the page/);
});

test('the anchor guidance appears only when a row really carries an anchor', () => {
  const withNone = buildPrompt({
    ...anchorBase,
    rows: [{ id: 'r1', num: 1, cells: [], lat: 1, lon: 2, file: 'a.pdf', page: 4, anchors: [] }],
    pages: anchoredPages(), anchor: true,
  });
  assert.doesNotMatch(withNone.system, /anchored span IS that row/);
  assert.match(withNone.system, /you cannot find support for the coordinates/);

  const withOne = buildPrompt({ ...anchorBase, rows: [anchoredRow()], pages: anchoredPages(), anchor: true });
  assert.match(withOne.system, /anchored span IS that row/);
  assert.match(withOne.system, /\[\[<row id>\.lat\]\]/);
});

test('VERIFY reserves not_found for unanchored rows', () => {
  const on = buildPrompt({ ...anchorBase, rows: [anchoredRow()], pages: anchoredPages(), anchor: true });
  assert.match(on.system, /ITS OWN ANCHORED SPAN/);
  assert.match(on.system, /ONLY for a row with no anchor here/);
  const off = buildPrompt({ ...anchorBase, rows: [anchoredRow()], pages: anchoredPages() });
  assert.match(off.system, /you cannot find support for the coordinates/);
  assert.doesNotMatch(off.system, /ANCHORED SPAN/);
});

test('the other tasks point at the anchored span when anchoring is on', () => {
  // A third column keeps FILL alive: with only two, Genus and Species already
  // cover both and FILL is skipped by design.
  const args = {
    ...anchorBase, cols: ['Genus', 'Species', 'Depth'],
    rows: [anchoredRow()], pages: anchoredPages(), species: true, notes: true, notesSpec: '',
  };
  const on = buildPrompt({ ...args, anchor: true });
  for (const task of ['GENUS', 'SPECIES', 'FILL', 'NOTES', 'FLAG']) assert.match(on.system, new RegExp(task));
  assert.equal(on.system.split("around that row's anchored span").length - 1, 5);
  assert.doesNotMatch(on.system, /near that row's coordinates/);

  const off = buildPrompt(args);
  assert.match(off.system, /near that row's coordinates/);
  assert.doesNotMatch(off.system, /anchored span/);
});

test('every anchor key on a row line appears in the document text, and vice versa', () => {
  // A mixed fixture: one placed, one off-page, one truncated away, one overlap.
  const text = 'AAAA 11.1 BBBB 22.2 CCCC';
  const rows = [
    { id: 'r1', num: 1, cells: [], lat: 1, lon: 2, file: 'f.pdf', page: 1, anchors: [
      { label: 'lat', file: 'f.pdf', page: 1, start: 5, end: 9 },
      { label: 'lon', file: 'f.pdf', page: 9, start: 0, end: 4 },
    ] },
    { id: 'r2', num: 2, cells: [], lat: 1, lon: 2, file: 'f.pdf', page: 1, anchors: [
      { label: 'lat', file: 'f.pdf', page: 1, start: 6, end: 9 },
      { label: 'lon', file: 'f.pdf', page: 1, start: 15, end: 19 },
    ] },
  ];
  const { user } = buildPrompt({ ...anchorBase, rows, pages: [{ file: 'f.pdf', page: 1, text }], anchor: true });
  const split = user.indexOf('DOCUMENT TEXT:');
  const rowBlock = user.slice(0, split);
  const docBlock = user.slice(split);
  const keys = (s) => new Set((s.match(/\[\[[^\]]+\]\]/g) || []).filter((m) => m !== '[[/]]'));
  assert.deepEqual([...keys(rowBlock)].sort(), [...keys(docBlock)].sort());
  assert.ok(keys(rowBlock).size > 0);
});

test('chunkWork leaves room for the anchors it will not see', () => {
  const pages = [
    { file: 'f', page: 1, text: 'x'.repeat(400) },
    { file: 'f', page: 2, text: 'y'.repeat(400) },
  ];
  const plain = [{ id: 'r1', page: 1 }, { id: 'r2', page: 2 }];
  const withAnchors = plain.map((r) => ({ ...r, anchors: [{ label: 'lat' }, { label: 'lon' }] }));
  assert.ok(ANCHOR_OVERHEAD > 0);
  assert.equal(chunkWork(pages, plain, 1000).length, 1);
  // 2 anchors × ANCHOR_OVERHEAD per page pushes the pair over the same budget.
  assert.equal(chunkWork(pages, withAnchors, 1000).length, 2);
});

test('both chunkers record how much of a trimmed page survived', () => {
  const pages = [{ file: 'f', page: 1, text: 'a'.repeat(500) }, { file: 'f', page: 2, text: 'short' }];
  const rows = [{ id: 'r1', page: 1 }, { id: 'r2', page: 2 }];
  for (const chunks of [chunkWork(pages, rows, 100), chunkPerPage(pages, rows, 100)]) {
    const all = chunks.flatMap((c) => c.pages);
    const big = all.find((p) => p.page === 1);
    const small = all.find((p) => p.page === 2);
    assert.equal(big.truncatedAt, 100);
    assert.equal(small.truncatedAt, undefined);
    assert.ok(big.text.length > 100, 'the truncation notice makes the text longer than the cut');
  }
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

// --- renaming PDFs ----------------------------------------------------------

test('safeFileName keeps ordinary names intact', () => {
  assert.equal(safeFileName('Xenopygus'), 'Xenopygus');
  assert.equal(safeFileName('lions'), 'lions');
  assert.equal(safeFileName('Panthera leo'), 'Panthera leo');
  assert.equal(safeFileName('Nausicotus-removal_2'), 'Nausicotus-removal_2');
  // An extension the model added itself is dropped, not doubled up.
  assert.equal(safeFileName('lions.pdf'), 'lions');
  assert.equal(safeFileName('  Xantho  '), 'Xantho');
});

test('safeFileName strips anything a filesystem would choke on', () => {
  // Path separators and the characters Windows forbids. The separators are
  // built from String.raw so the backslash cannot be lost to escaping.
  assert.equal(safeFileName(String.raw`a/b\c:d*e?f"g<h>i|j`), 'a b c d e f g h i j');
  assert.equal(safeFileName(String.raw`C:\Users\me\lions.pdf`), 'C Users me lions');
  // No traversal can survive, whatever the model returns.
  assert.equal(safeFileName('../../etc/passwd'), 'etc passwd');
  assert.equal(safeFileName('..'), '');
  // A leading dot would hide the file; trailing dots/spaces are dropped by
  // Windows anyway, so they must not be part of the name we ask for.
  assert.equal(safeFileName('.hidden'), 'hidden');
  assert.equal(safeFileName('name.'), 'name');
  assert.equal(safeFileName('name '), 'name');
  // Nothing usable left means "no suggestion", not a file called "-".
  assert.equal(safeFileName(''), '');
  assert.equal(safeFileName('   '), '');
  assert.equal(safeFileName('///'), '');
  assert.equal(safeFileName(null), '');
  assert.equal(safeFileName(undefined), '');
});

test('safeFileName sidesteps the Windows reserved names', () => {
  for (const reserved of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9']) {
    assert.equal(safeFileName(reserved), `${reserved}_`);
  }
  // Only the exact names are reserved.
  assert.equal(safeFileName('CONtext'), 'CONtext');
  assert.equal(safeFileName('COM11'), 'COM11');
});

test('safeFileName clamps a rambling answer', () => {
  const long = safeFileName('x'.repeat(500));
  assert.equal(long.length, MAX_FILE_NAME);
  // Clamping must not leave a trailing dot or space behind.
  const clamped = safeFileName(`${'a'.repeat(MAX_FILE_NAME - 1)}. tail`);
  assert.ok(!/[. ]$/.test(clamped));
});

test('safeFileName keeps non-ASCII letters', () => {
  assert.equal(safeFileName('Volcán'), 'Volcán');
  assert.equal(safeFileName('Potosí 2'), 'Potosí 2');
});

test('uniqueFileName numbers collisions instead of overwriting', () => {
  const taken = new Set();
  assert.equal(uniqueFileName('lions', taken), 'lions.pdf');
  assert.equal(uniqueFileName('lions', taken), 'lions-2.pdf');
  assert.equal(uniqueFileName('lions', taken), 'lions-3.pdf');
  assert.equal(uniqueFileName('tigers', taken), 'tigers.pdf');
  // Case-insensitive, because Windows and macOS are: LIONS has to skip past
  // lions, lions-2 and lions-3 rather than collide with any of them.
  assert.equal(uniqueFileName('LIONS', taken), 'LIONS-4.pdf');
});

test('buildRenamePrompt carries the naming spec and the pages', () => {
  const { system, user } = buildRenamePrompt({
    fileName: '168766.pdf',
    pages: [{ page: 1, text: 'A revision of the genus Xenopygus Bernhauer' }],
    spec: 'the genus discussed in the paper',
  });
  assert.match(system, /the genus discussed in the paper/);
  assert.match(system, /ONE word/);
  assert.match(system, /"file"/); // the JSON shape it must answer in
  assert.match(user, /168766\.pdf/);
  assert.match(user, /Xenopygus Bernhauer/);
  assert.match(user, /page 1/);
});

test('buildRenamePrompt falls back to the default spec', () => {
  for (const spec of ['', '   ', undefined, null]) {
    const { system } = buildRenamePrompt({ fileName: 'a.pdf', pages: [], spec });
    assert.match(system, new RegExp(DEFAULT_RENAME_SPEC));
  }
});

test('normalizeRename sanitises what the model returned', () => {
  assert.deepEqual(
    normalizeRename({ file: '168766.pdf', name: 'Xenopygus.pdf', note: 'Title names the genus.' }),
    { name: 'Xenopygus', note: 'Title names the genus.' }
  );
  assert.equal(normalizeRename({ name: '  ' }), null); // "I could not tell"
  assert.equal(normalizeRename({ name: '' }), null);
  assert.equal(normalizeRename({}), null);
  assert.equal(normalizeRename(null), null);
  assert.equal(normalizeRename('Xenopygus'), null); // not an object
  // A note is optional and always a string.
  assert.equal(normalizeRename({ name: 'Xantho' }).note, '');
  assert.equal(normalizeRename({ name: 'Xantho', note: 42 }).note, '');
});

test('every provider offers models and a usable default', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    if (id === 'custom') continue; // deliberately blank — the user fills it in
    assert.ok(p.models.length > 0, `${id} lists no models`);
    assert.ok(p.models.includes(p.model), `${id}: default "${p.model}" is not in its model list`);
    assert.ok(p.url.startsWith('https://'), `${id} needs an https endpoint`);
    assert.ok(p.keyUrl.startsWith('https://'), `${id} needs a key page to link to`);
    assert.equal(new Set(p.models).size, p.models.length, `${id} lists a model twice`);
  }
});

test('no current preset is a retired model', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    for (const m of p.models) assert.ok(!RETIRED_MODELS.has(m), `${id} still offers retired "${m}"`);
  }
});

test('dropRetiredModels forgets retired choices and keeps the rest', () => {
  const kept = dropRetiredModels({
    deepseek: 'deepseek-reasoner', kimi: 'kimi-k2.5', anthropic: 'claude-sonnet-5', custom: 'local-llama',
  });
  assert.deepEqual(kept, { anthropic: 'claude-sonnet-5', custom: 'local-llama' });
  assert.deepEqual(dropRetiredModels(undefined), {});
});

test('OpenRouter is wired for any model', () => {
  const p = PROVIDERS.openrouter;
  assert.equal(p.kind, 'openai');
  assert.ok(p.modelsUrl.startsWith('https://openrouter.ai/'));
  // OpenRouter IDs are author/slug.
  for (const m of p.models) assert.match(m, /^[\w.-]+\/[\w.:-]+$/, m);
});

test('parseModelList reads an OpenRouter-style catalog', () => {
  const ids = parseModelList(JSON.stringify({
    data: [
      { id: 'z-ai/glm-5.3', architecture: { output_modalities: ['text'] } },
      { id: 'anthropic/claude-sonnet-5.5' }, // no architecture: assume text
      { id: 'google/some-image-model', architecture: { output_modalities: ['image'] } },
      { id: 'anthropic/claude-sonnet-5.5' }, // duplicate
      { id: '' }, null, { name: 'no id' },
    ],
  }));
  assert.deepEqual(ids, ['anthropic/claude-sonnet-5.5', 'z-ai/glm-5.3']);
});

test('parseModelList rejects errors and non-lists', () => {
  assert.throws(() => parseModelList('<html>'), /not JSON/);
  assert.throws(() => parseModelList(JSON.stringify({ error: { message: 'nope' } })), /nope/);
  assert.throws(() => parseModelList(JSON.stringify({ models: [] })), /no model list/);
});

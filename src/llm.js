// CoordRippr LLM assist: provider presets, request building, response parsing,
// prompt construction and work chunking. Pure module — no DOM, no Electron —
// so it runs under node --test. The actual HTTP call happens elsewhere
// (Electron main process, or browser fetch in the web build).

// ---------------------------------------------------------------------------
// Providers. Everything speaks either the Anthropic Messages API or the
// OpenAI-compatible chat completions shape (which all the majors, including
// the Chinese providers, expose).
// ---------------------------------------------------------------------------

// Each provider ships a short curated list of current model IDs for the model
// dropdown. `model` is the default (must be one of `models`); users can always
// pick "Custom…" and type any other ID. Model names were verified current as of
// July 2026 — refresh these when providers rotate their line-ups (several older
// defaults, e.g. DeepSeek's deepseek-chat, Gemini's gemini-2.0-flash, Kimi's
// kimi-latest and GLM's glm-4-flash, have since been retired or deprecated).
// `keyUrl`/`keyName` point the user at the page where they can obtain an API
// key for that provider (surfaced as a link next to the key field in the UI).
export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    kind: 'anthropic',
    url: 'https://api.anthropic.com/v1/messages',
    model: 'claude-opus-4-8',
    models: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5'],
    keyHint: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyName: 'Anthropic Console',
  },
  openai: {
    label: 'OpenAI (GPT)',
    kind: 'openai',
    url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-5.1',
    models: ['gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1'],
    keyHint: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyName: 'OpenAI Platform',
  },
  gemini: {
    label: 'Google (Gemini)',
    kind: 'openai',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.5-flash', 'gemini-flash-latest'],
    keyHint: 'AIza…',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyName: 'Google AI Studio',
  },
  deepseek: {
    label: 'DeepSeek',
    kind: 'openai',
    url: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-v4-flash',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    keyHint: 'sk-…',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyName: 'DeepSeek Platform',
  },
  qwen: {
    label: 'Qwen (Alibaba DashScope)',
    kind: 'openai',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-plus',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen3-max'],
    keyHint: 'sk-…',
    keyUrl: 'https://dashscope.console.aliyun.com/apiKey',
    keyName: 'Alibaba Cloud DashScope',
  },
  kimi: {
    label: 'Kimi (Moonshot)',
    kind: 'openai',
    url: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'kimi-k2.6',
    models: ['kimi-k2.6', 'kimi-k2.5', 'kimi-k2.7-code', 'moonshot-v1-128k', 'moonshot-v1-32k'],
    keyHint: 'sk-…',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    keyName: 'Moonshot Platform',
  },
  zhipu: {
    label: 'GLM (Zhipu / BigModel)',
    kind: 'openai',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4.6',
    models: ['glm-4.6', 'glm-4.7', 'glm-4.5', 'glm-4.5-air', 'glm-4-flash'],
    keyHint: '…',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    keyName: 'Zhipu BigModel',
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    kind: 'openai',
    url: '',
    model: '',
    models: [],
    keyHint: 'optional for local endpoints',
    keyUrl: '',
    keyName: '',
  },
};

// ---------------------------------------------------------------------------
// Request / response wire formats
// ---------------------------------------------------------------------------

/**
 * Build a ready-to-send HTTP request for one chat turn.
 * `browser` adds the CORS opt-in header Anthropic requires for direct
 * browser calls (used by the GitHub Pages build; Electron proxies via main).
 */
export function buildRequest({ kind, url, model, apiKey, system, user, maxTokens = 4096, browser = false }) {
  if (!url) throw new Error('No endpoint URL configured');
  if (kind === 'anthropic') {
    const headers = {
      'content-type': 'application/json',
      'x-api-key': apiKey || '',
      'anthropic-version': '2023-06-01',
    };
    if (browser) headers['anthropic-dangerous-direct-browser-access'] = 'true';
    return {
      url,
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    };
  }
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return {
    url,
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  };
}

/** Pull the assistant's text out of a raw response body. Throws on API errors. */
export function extractText(kind, responseText) {
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`Provider returned non-JSON response: ${responseText.slice(0, 200)}`);
  }
  if (kind === 'anthropic') {
    if (data.type === 'error') {
      throw new Error(data.error?.message || 'Anthropic API error');
    }
    if (data.stop_reason === 'refusal') {
      throw new Error('The model declined this request (refusal).');
    }
    return (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }
  if (data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error).slice(0, 200));
  }
  const choice = data.choices && data.choices[0];
  if (!choice) throw new Error('Provider returned no choices');
  return choice.message?.content ?? '';
}

/**
 * Robustly extract a JSON array of row results from LLM output that may be
 * wrapped in code fences or prose. Returns [] when nothing parseable exists.
 */
export function parseResultsJson(text) {
  if (!text) return [];
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('[');
  if (start < 0) return [];
  // Walk to the matching close bracket, respecting strings.
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        try {
          const arr = JSON.parse(cleaned.slice(start, i + 1));
          return Array.isArray(arr) ? arr.filter((x) => x && typeof x === 'object') : [];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const VERDICTS = ['ok', 'mismatch', 'not_found'];

/**
 * @param {object} r        raw result object from the model
 * @param {number} colCount how many data columns ("col1"…"colN") to read
 */
export function normalizeResult(r, colCount = 2) {
  const cols = [];
  for (let i = 1; i <= colCount; i++) {
    const v = r[`col${i}`];
    cols.push(typeof v === 'string' ? v.trim() : '');
  }
  const out = {
    row: typeof r.row === 'string' || typeof r.row === 'number' ? String(r.row) : null,
    verdict: VERDICTS.includes(r.verdict) ? r.verdict : null,
    lat: typeof r.lat === 'number' && Math.abs(r.lat) <= 90 ? r.lat : null,
    lon: typeof r.lon === 'number' && Math.abs(r.lon) <= 180 ? r.lon : null,
    cols,
    notesCol: typeof r.notes_col === 'string' ? r.notes_col.trim().slice(0, 800) : '',
    note: typeof r.note === 'string' ? r.note.trim().slice(0, 400) : '',
    // Only a literal true marks a row for deletion — anything else is "keep".
    del: r.delete === true,
    // Only a literal true counts as "please resend with the previous page".
    needPrev: r.need_prev === true,
    // Only a literal true counts as "please resend with the next page".
    needNext: r.need_next === true,
  };
  return out.row ? out : null;
}

/**
 * @param {object} p
 * @param {Array} p.rows    [{id, num, cells, lat, lon, file, page}]
 * @param {Array} p.pages   [{file, page, text}]
 * @param {Array<string>} p.cols  data column header names (col1…colN)
 * @param {string} p.extra  user's additional instructions
 * @param {boolean} p.verify
 * @param {boolean} p.fill
 * @param {boolean} p.flagDelete  ask the model to flag false-positive rows
 * @param {boolean} p.notes      fill the extra Notes column ("notes_col")
 * @param {string}  p.notesSpec  what the user wants the notes to contain
 * @param {boolean} p.allowPrev  model may request the preceding page via "need_prev"
 * @param {boolean} p.allowNext  model may request the following page via "need_next"
 */
export function buildPrompt({ rows, pages, cols, extra, verify, fill, flagDelete, notes, notesSpec, allowPrev, allowNext }) {
  const colKeys = cols.map((_, i) => `"col${i + 1}"`);
  const tasks = [];
  if (verify) {
    tasks.push(
      `- VERIFY each row's latitude/longitude against the document text. ` +
        `"ok" = the coordinates appear in the text (allow formatting/rounding differences and DMS-vs-decimal conversion). ` +
        `"mismatch" = the text clearly indicates different values: put the corrected decimal-degree values in "lat"/"lon". ` +
        `"not_found" = you cannot find support for the coordinates in the text.`
    );
  }
  if (fill) {
    const naming = cols.map((name, i) => `column ${i + 1} is named "${name}"`).join(', ');
    tasks.push(
      `- FILL ${colKeys.join(', ')} for each row using information in the document text near that row's coordinates. ` +
        `${naming.charAt(0).toUpperCase()}${naming.slice(1)} — fill each with the value its name implies. ` +
        `If the names are generic, use the most useful identifying label from the text (site/sample/species/place name) for col1 ` +
        `and further distinguishing attributes for the rest. Keep values short. Use "" when the text offers nothing.`
    );
  }
  if (allowPrev || allowNext) {
    const flips = [];
    if (allowPrev) {
      flips.push(
        `set "need_prev": true on that row and it will be resent to you with the preceding page included`
      );
    }
    if (allowNext) {
      flips.push(
        `set "need_next": true on that row and it will be resent to you with the following page included`
      );
    }
    tasks.push(
      `- PAGE CONTEXT: when the information a row needs — a data column value, or anything the user's added instructions ` +
        `ask for — is not in the text you were given but likely sits on an adjacent page (a table, list or passage that ` +
        `started earlier or continues later), ${flips.join('; or ')}. Leave the still-unknown columns "" in the meantime. ` +
        `Only request a page when the current text genuinely lacks the information.`
    );
  }
  if (notes) {
    tasks.push(
      `- NOTES: fill "notes_col" for each row (this is a separate user-facing Notes column, not your "note" reasoning). ` +
        `The user wants the notes to contain: ${(notesSpec || '').trim() || 'a short, useful observation about this row drawn from the document text'}. ` +
        `Keep each note short and grounded in the text. Use "" when there is nothing relevant.`
    );
  }
  if (flagDelete) {
    tasks.push(
      `- FLAG false positives: set "delete": true on rows whose values are clearly NOT geographic coordinates ` +
        `(dates, years, measurements, page or figure numbers, sample counts, citation spans, ratios, …) ` +
        `based on the surrounding text, and say why in "note". ` +
        `Set "delete": false whenever the row is, or even might be, a real coordinate — when in doubt, keep it.`
    );
  }

  const system =
    `You are a meticulous data-extraction assistant for CoordRippr, a tool that pulls geographic coordinates out of PDFs. ` +
    `You receive CSV rows (coordinates with page references) and the text of the PDF pages they came from.\n\n` +
    `Tasks:\n${tasks.join('\n')}\n\n` +
    `Respond with ONLY a JSON array, no prose, one object per row:\n` +
    `[{"row": "<row id exactly as given>", "verdict": "ok"|"mismatch"|"not_found", ` +
    `"lat": <decimal degrees or null>, "lon": <decimal degrees or null>, ` +
    `${colKeys.map((k) => `${k}: "<string>"`).join(', ')}` +
    `${notes ? ', "notes_col": "<string>"' : ''}` +
    `${flagDelete ? ', "delete": true|false' : ''}` +
    `${allowPrev ? ', "need_prev": true|false' : ''}` +
    `${allowNext ? ', "need_next": true|false' : ''}, ` +
    `"note": "<one short sentence of reasoning>"}]\n\n` +
    `Include every row you were given exactly once. Never invent coordinates that are not grounded in the text.`;

  const lines = [];
  if (extra && extra.trim()) {
    lines.push(`Additional instructions from the user:\n${extra.trim()}\n`);
  }
  lines.push(`CSV rows (id | row # | ${cols.join(' | ')} | latitude | longitude | source):`);
  for (const r of rows) {
    const cells = cols.map((_, i) => (r.cells && r.cells[i]) || '');
    lines.push(
      `${r.id} | ${r.num} | ${cells.join(' | ')} | ${r.lat ?? ''} | ${r.lon ?? ''} | ${r.file} p.${r.page}`
    );
  }
  lines.push('');
  lines.push('DOCUMENT TEXT:');
  for (const p of pages) {
    lines.push(`--- ${p.file} — page ${p.page} ---`);
    lines.push(p.text);
  }
  return { system, user: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Chunking: keep each request under a character budget
// ---------------------------------------------------------------------------

export const DEFAULT_CHAR_BUDGET = 24000;
export const MAX_ROWS_PER_CHUNK = 40;

/**
 * Split one file's work into chunks. Pages are added in order; a chunk closes
 * when the text budget or the row cap is hit. Every row rides with its page.
 *
 * @param {Array} pages [{file, page, text}]
 * @param {Array} rows  [{id, page, ...}] rows referencing those pages
 * @returns {Array<{pages: Array, rows: Array}>}
 */
export function chunkWork(pages, rows, budget = DEFAULT_CHAR_BUDGET) {
  const chunks = [];
  let cur = { pages: [], rows: [], chars: 0 };
  const rowsByPage = new Map();
  for (const r of rows) {
    if (!rowsByPage.has(r.page)) rowsByPage.set(r.page, []);
    rowsByPage.get(r.page).push(r);
  }

  const close = () => {
    if (cur.pages.length) chunks.push({ pages: cur.pages, rows: cur.rows });
    cur = { pages: [], rows: [], chars: 0 };
  };

  for (const page of pages) {
    const pageRows = rowsByPage.get(page.page) || [];
    const size = page.text.length + 50;
    if (
      cur.pages.length > 0 &&
      (cur.chars + size > budget || cur.rows.length + pageRows.length > MAX_ROWS_PER_CHUNK)
    ) {
      close();
    }
    // A single oversized page still goes out alone (trimmed).
    const text = page.text.length > budget ? page.text.slice(0, budget) + '\n[…page text truncated…]' : page.text;
    cur.pages.push({ ...page, text });
    cur.rows.push(...pageRows);
    cur.chars += size;
  }
  close();
  // Drop chunks that carry no rows — nothing to verify or fill there.
  return chunks.filter((c) => c.rows.length > 0);
}

/**
 * Strict per-page batching: each page's rows go out with ONLY that page's
 * text, one request per page (split further only when a single page exceeds
 * the row cap). Pages without rows are skipped entirely.
 *
 * Per-page mode is where parallelism pays off most: it fans one PDF out into
 * many small, fully independent requests (see `runPool`).
 *
 * @param {Array} pages [{file, page, text}]
 * @param {Array} rows  [{id, page, ...}] rows referencing those pages
 * @returns {Array<{pages: Array, rows: Array}>}
 */
export function chunkPerPage(pages, rows, budget = DEFAULT_CHAR_BUDGET) {
  const rowsByPage = new Map();
  for (const r of rows) {
    if (!rowsByPage.has(r.page)) rowsByPage.set(r.page, []);
    rowsByPage.get(r.page).push(r);
  }
  const chunks = [];
  for (const page of pages) {
    const pageRows = rowsByPage.get(page.page) || [];
    if (pageRows.length === 0) continue;
    const text = page.text.length > budget ? page.text.slice(0, budget) + '\n[…page text truncated…]' : page.text;
    for (let i = 0; i < pageRows.length; i += MAX_ROWS_PER_CHUNK) {
      chunks.push({ pages: [{ ...page, text }], rows: pageRows.slice(i, i + MAX_ROWS_PER_CHUNK) });
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Bounded-concurrency runner: send several requests at once
// ---------------------------------------------------------------------------

// How many requests may be in flight at once by default, and the ceiling the
// UI exposes. Kept modest so a big per-page fan-out doesn't trip provider rate
// limits; 1 reproduces the old strictly-sequential behaviour.
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 8;

/**
 * Run `worker(item, index)` over `items` with at most `limit` calls in flight
 * at once (a fixed-size pool of runners pulling from a shared cursor). Results
 * are returned in the ORIGINAL item order regardless of completion order, so a
 * caller can rely on positions even though the work overlaps.
 *
 * Because JavaScript is single-threaded, each worker runs to its next `await`
 * without interruption — so a worker that mutates shared state synchronously
 * after its own `await` (e.g. applying a parsed response) can never interleave
 * with another. That is what makes it safe to apply LLM results from inside the
 * pool.
 *
 * `shouldStop()`, when provided, is polled before each item is picked up; once
 * it returns true no new items are started (in-flight ones still finish) and
 * their result slots stay `undefined`. This preserves the app's "stop after the
 * current request" / auth-failure short-circuit semantics.
 *
 * @param {Array} items
 * @param {number} limit           max concurrent workers (coerced to >= 1)
 * @param {(item, index) => Promise} worker
 * @param {() => boolean} [shouldStop]
 * @returns {Promise<Array>} results in item order
 */
export async function runPool(items, limit, worker, shouldStop = () => false) {
  const n = items.length;
  const results = new Array(n);
  const size = Math.max(1, Math.min(Math.floor(limit) || 1, n || 1));
  let next = 0;
  const runner = async () => {
    for (;;) {
      if (shouldStop()) return;
      const i = next++;
      if (i >= n) return;
      results[i] = await worker(items[i], i);
    }
  };
  const runners = [];
  for (let k = 0; k < size; k++) runners.push(runner());
  await Promise.all(runners);
  return results;
}

// CoordRippr LLM assist: provider presets, request building, response parsing,
// prompt construction and work chunking. Pure module — no DOM, no Electron —
// so it runs under node --test. The actual HTTP call happens elsewhere
// (Electron main process, or browser fetch in the web build).

// ---------------------------------------------------------------------------
// Providers. Everything speaks either the Anthropic Messages API or the
// OpenAI-compatible chat completions shape (which all the majors, including
// the Chinese providers, expose).
// ---------------------------------------------------------------------------

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    kind: 'anthropic',
    url: 'https://api.anthropic.com/v1/messages',
    model: 'claude-opus-4-8',
    keyHint: 'sk-ant-…',
  },
  openai: {
    label: 'OpenAI (GPT)',
    kind: 'openai',
    url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    keyHint: 'sk-…',
  },
  gemini: {
    label: 'Google (Gemini)',
    kind: 'openai',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-2.0-flash',
    keyHint: 'AIza…',
  },
  deepseek: {
    label: 'DeepSeek',
    kind: 'openai',
    url: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
    keyHint: 'sk-…',
  },
  qwen: {
    label: 'Qwen (Alibaba DashScope)',
    kind: 'openai',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-plus',
    keyHint: 'sk-…',
  },
  kimi: {
    label: 'Kimi (Moonshot)',
    kind: 'openai',
    url: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'kimi-latest',
    keyHint: 'sk-…',
  },
  zhipu: {
    label: 'GLM (Zhipu / BigModel)',
    kind: 'openai',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4-flash',
    keyHint: '…',
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    kind: 'openai',
    url: '',
    model: '',
    keyHint: 'optional for local endpoints',
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

export function normalizeResult(r) {
  const out = {
    row: typeof r.row === 'string' || typeof r.row === 'number' ? String(r.row) : null,
    verdict: VERDICTS.includes(r.verdict) ? r.verdict : null,
    lat: typeof r.lat === 'number' && Math.abs(r.lat) <= 90 ? r.lat : null,
    lon: typeof r.lon === 'number' && Math.abs(r.lon) <= 180 ? r.lon : null,
    col1: typeof r.col1 === 'string' ? r.col1.trim() : '',
    col2: typeof r.col2 === 'string' ? r.col2.trim() : '',
    note: typeof r.note === 'string' ? r.note.trim().slice(0, 400) : '',
  };
  return out.row ? out : null;
}

/**
 * @param {object} p
 * @param {Array} p.rows    [{id, num, c1, c2, lat, lon, file, page}]
 * @param {Array} p.pages   [{file, page, text}]
 * @param {object} p.headers {c1, c2} column header names
 * @param {string} p.extra  user's additional instructions
 * @param {boolean} p.verify
 * @param {boolean} p.fill
 */
export function buildPrompt({ rows, pages, headers, extra, verify, fill }) {
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
    tasks.push(
      `- FILL "col1" and "col2" for each row using information in the document text near that row's coordinates. ` +
        `Column 1 is named "${headers.c1}" and column 2 is named "${headers.c2}" — fill them with the values those names imply. ` +
        `If the names are generic, use the most useful identifying label from the text (site/sample/species/place name) for col1 ` +
        `and a second distinguishing attribute for col2. Keep values short. Use "" when the text offers nothing.`
    );
  }

  const system =
    `You are a meticulous data-extraction assistant for CoordRippr, a tool that pulls geographic coordinates out of PDFs. ` +
    `You receive CSV rows (coordinates with page references) and the text of the PDF pages they came from.\n\n` +
    `Tasks:\n${tasks.join('\n')}\n\n` +
    `Respond with ONLY a JSON array, no prose, one object per row:\n` +
    `[{"row": "<row id exactly as given>", "verdict": "ok"|"mismatch"|"not_found", ` +
    `"lat": <decimal degrees or null>, "lon": <decimal degrees or null>, ` +
    `"col1": "<string>", "col2": "<string>", "note": "<one short sentence of reasoning>"}]\n\n` +
    `Include every row you were given exactly once. Never invent coordinates that are not grounded in the text.`;

  const lines = [];
  if (extra && extra.trim()) {
    lines.push(`Additional instructions from the user:\n${extra.trim()}\n`);
  }
  lines.push(`CSV rows (id | row # | ${headers.c1} | ${headers.c2} | latitude | longitude | source):`);
  for (const r of rows) {
    lines.push(
      `${r.id} | ${r.num} | ${r.c1 || ''} | ${r.c2 || ''} | ${r.lat ?? ''} | ${r.lon ?? ''} | ${r.file} p.${r.page}`
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

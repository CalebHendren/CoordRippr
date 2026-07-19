// CoordRippr renderer: batch-scans PDFs for coordinates, shows highlighted
// pages on the right, editable CSV preview on the left, with two-way jumping.

import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.min.mjs';
import {
  extractCoordinates, extractCrossPage, parseSingle, formatDD, formatDMS,
  DEFAULT_INTENSITY, INTENSITY_LABELS,
} from './coords.js';
import { buildPageText, rectsForRange } from './pdftext.js';
import {
  PROVIDERS, buildRequest, extractText, parseResultsJson, normalizeResult,
  buildPrompt, oneWord, chunkWork, chunkPerPage, runPool, runBatched,
  DEFAULT_CONCURRENCY, MAX_CONCURRENCY, DEFAULT_BATCH_DELAY, MAX_BATCH_DELAY_MS,
  DEFAULT_TEMPERATURE, MIN_TEMPERATURE, MAX_TEMPERATURE,
} from './llm.js';
import { buildImagePdf } from './pdfout.js';
import { RELEASES_API, RELEASES_PAGE, KOFI_URL, isNewer, isDue } from './updates.js';
import { packState, unpackState, storage } from './persist.js';
import { findDuplicateRowIds } from './dedup.js';

const api = window.coordrippr;
const IS_WEB = api.platform === 'web';

const PDFJS_BASE = new URL('../node_modules/pdfjs-dist/', import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('build/pdf.worker.min.mjs', PDFJS_BASE).href;
const PDF_OPEN_OPTS = {
  standardFontDataUrl: new URL('standard_fonts/', PDFJS_BASE).href,
  cMapUrl: new URL('cmaps/', PDFJS_BASE).href,
  cMapPacked: true,
  isEvalSupported: false,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  files: [], // {id, name, path, doc, error, numPages, pages:[{num,w,h,proxy,dets:[]}]}
  dets: new Map(), // detId -> {id, fileId, pageNum, rects, rowId, half, raw, span}
  rows: [], // {id, cells:[…], notes, lat, lon, latRaw, lonRaw, src:{fileId,pageNum,latDet,lonDet,extraDets?}}
  cols: ['Genus', 'Species'], // data column headers (2 by default, user can add more)
  notesOn: false, // the LLM-filled Notes column exists only after a notes run
  fmt: 'dd', // 'dd' | 'dms' | 'both'
  showAll: false,
  showHighlights: true,
  zoom: 1.4,
  intensity: DEFAULT_INTENSITY, // regex net width, 1 (strictest) … 7 (everything)
  currentFile: null,
  suppressed: new Set(), // location keys of deleted detections (survive re-scans)
  selected: new Set(),
  anchor: null,
  activeRow: null,
  busy: false,
};

// Active project ({id, name, …}) and the full projects list.
let project = null;
let projects = [];

let nextId = 1;
const uid = (p) => `${p}${nextId++}`;

const emptyCells = () => state.cols.map(() => '');
const cellVal = (row, i) => (row.cells && row.cells[i]) || '';

// A file's effective detection net: its own per-PDF override when set, else the
// global toolbar net. Lets a messy PDF be scanned more aggressively (or a clean
// one more strictly) without changing the net for the rest of the batch.
const fileIntensity = (file) => (file && file.intensity != null ? file.intensity : state.intensity);

const $ = (sel) => document.querySelector(sel);
const pagesEl = $('#pages');
const fileListEl = $('#filelist');
const theadEl = $('#csv-table thead');
const tbodyEl = $('#csv-table tbody');
const statusEl = $('#status');

let pageObserver = null;

// ---------------------------------------------------------------------------
// Status / busy
// ---------------------------------------------------------------------------

function setStatus(msg, busy = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('busy', busy);
}

function refreshCounts() {
  const nFiles = state.files.length;
  const nPages = state.files.reduce(
    (a, f) => a + f.pages.filter((p) => p.dets.length).length, 0);
  setStatus(`${nFiles} PDF${nFiles === 1 ? '' : 's'} · ${nPages} page${nPages === 1 ? '' : 's'} with coordinates · ${state.rows.length} row${state.rows.length === 1 ? '' : 's'}`);
}

// ---------------------------------------------------------------------------
// Loading & scanning
// ---------------------------------------------------------------------------

async function loadFiles(specs) {
  if (!specs || specs.length === 0) return;
  state.busy = true;
  let done = 0;
  for (const spec of specs) {
    done++;
    const file = {
      id: uid('f'), name: spec.name, path: spec.path || null,
      doc: null, error: null, numPages: 0, pages: [],
      intensity: null, // per-PDF net override; null = follow the global net
    };
    state.files.push(file);
    try {
      setStatus(`Scanning ${spec.name} (${done}/${specs.length})…`, true);
      const data = spec.data || (await api.readFile(spec.path));
      // Pathless PDFs (drag & drop, web) can only be restored from stored
      // bytes — copy before pdf.js transfers the buffer to its worker.
      if (project && !file.path) {
        const copy = data.slice(0);
        storage.savePdf(project.id, file.id, file.name, copy).catch(() => {});
      }
      file.doc = await pdfjsLib.getDocument({ data, ...PDF_OPEN_OPTS }).promise;
      file.numPages = file.doc.numPages;
      let prevCtx = null;
      for (let p = 1; p <= file.numPages; p++) {
        const page = await file.doc.getPage(p);
        const vp = page.getViewport({ scale: 1 });
        const pageRec = { num: p, w: vp.width, h: vp.height, proxy: page, dets: [] };
        file.pages.push(pageRec);
        const tc = await page.getTextContent();
        const { text, spans } = buildPageText(tc);
        const ctx = { pageRec, text, spans };
        scanPage(file, ctx, prevCtx);
        prevCtx = ctx;
      }
    } catch (err) {
      file.error = err && err.message ? err.message : String(err);
    }
  }
  state.busy = false;
  if (state.currentFile == null) {
    const first = state.files.find((f) => f.pages.some((p) => p.dets.length)) || state.files[0];
    state.currentFile = first ? first.id : null;
  }
  renderAll();
  persistSoon();
}

// One page's detections: per-page pairs + pairs straddling the previous-page
// boundary. `reuse` (rescan) maps location keys to old rows so edits survive.
function scanPage(file, ctx, prevCtx, reuse = null) {
  const net = fileIntensity(file);
  for (const pair of extractCoordinates(ctx.text, net)) {
    addDetectedRow(file, ctx, pair, reuse);
  }
  if (prevCtx) {
    for (const pair of extractCrossPage(prevCtx.text, ctx.text, net)) {
      addCrossPageRow(file, prevCtx, ctx, pair, reuse);
    }
  }
}

// Location key of one detected token: survives re-scans (same file, page and
// character offset), used for edit-preserving rescans and delete suppression.
const locKey = (fileId, pageNum, half, start) => `${fileId}:${pageNum}:${half}:${start}`;

function addDetectedRow(file, ctx, pair, reuse = null) {
  const pageRec = ctx.pageRec;
  const halves = ['lat', 'lon'].filter((h) => pair[h]);
  const keys = halves.map((h) => locKey(file.id, pageRec.num, h, pair[h].start));
  if (keys.some((k) => state.suppressed.has(k))) return; // user deleted this one before

  // Rescan: reattach the old row (with its edits) when the detection still
  // matches; otherwise make a fresh row.
  let row = null;
  if (reuse) {
    for (const k of keys) {
      if (reuse.has(k)) { row = reuse.get(k); break; }
    }
  }
  if (row) {
    for (const k of keys) reuse.delete(k);
    row.src = { fileId: file.id, pageNum: pageRec.num, latDet: null, lonDet: null };
  } else {
    row = {
      id: uid('r'), cells: emptyCells(), notes: '',
      lat: pair.lat ? pair.lat.dd : null,
      lon: pair.lon ? pair.lon.dd : null,
      latRaw: null, lonRaw: null,
      src: { fileId: file.id, pageNum: pageRec.num, latDet: null, lonDet: null },
    };
  }
  for (const half of halves) {
    const tok = pair[half];
    const det = {
      id: uid('d'), fileId: file.id, pageNum: pageRec.num,
      rects: rectsForRange(ctx.spans, tok.start, tok.end),
      rowId: row.id, half, raw: tok.raw,
      span: [tok.start, tok.end],
    };
    state.dets.set(det.id, det);
    pageRec.dets.push(det.id);
    row.src[half + 'Det'] = det.id;
  }
  state.rows.push(row);
}

function findDetAt(fileId, pageNum, start, end) {
  for (const det of state.dets.values()) {
    if (det.fileId === fileId && det.pageNum === pageNum &&
        det.span && det.span[0] === start && det.span[1] === end) return det;
  }
  return null;
}

// A pair whose halves live on two different pages (lat at the bottom of one,
// lon at the top of the next — or a token broken by the page break itself).
function addCrossPageRow(file, prevCtx, curCtx, pair, reuse = null) {
  const ctxFor = (seg) => (seg.page === 'prev' ? prevCtx : curCtx);

  // The per-page scan may already hold these tokens as lone strong half-pairs.
  // A token already in a *full* pair makes this cross-page candidate redundant.
  const existing = [];
  for (const tok of [pair.lat, pair.lon]) {
    const seg = tok.segs[0];
    const det = findDetAt(file.id, ctxFor(seg).pageRec.num, seg.start, seg.end);
    if (det) existing.push(det);
  }
  for (const det of existing) {
    const row = state.rows.find((r) => r.id === det.rowId);
    if (row && row.src && row.src.latDet && row.src.lonDet) return;
  }

  // Suppression check (page + offset of each half's first segment).
  for (const tok of [pair.lat, pair.lon]) {
    const seg = tok.segs[0];
    const half = tok === pair.lat ? 'lat' : 'lon';
    if (state.suppressed.has(locKey(file.id, ctxFor(seg).pageRec.num, half, seg.start))) return;
  }

  // Absorb the lone half-rows into the merged pair.
  if (existing.length) removeRows(new Set(existing.map((d) => d.rowId)), { suppress: false });

  const latPage = ctxFor(pair.lat.segs[0]).pageRec.num;
  // Rescan: reattach the old merged row (with its edits) when it still matches.
  let row = null;
  if (reuse) {
    for (const tok of [pair.lat, pair.lon]) {
      const seg = tok.segs[0];
      const half = tok === pair.lat ? 'lat' : 'lon';
      const k = locKey(file.id, ctxFor(seg).pageRec.num, half, seg.start);
      if (reuse.has(k)) { row = reuse.get(k); reuse.delete(k); break; }
    }
  }
  if (row) {
    row.src = { fileId: file.id, pageNum: latPage, latDet: null, lonDet: null, extraDets: [] };
  } else {
    row = {
      id: uid('r'), cells: emptyCells(), notes: '',
      lat: pair.lat.dd, lon: pair.lon.dd,
      latRaw: null, lonRaw: null,
      src: { fileId: file.id, pageNum: latPage, latDet: null, lonDet: null, extraDets: [] },
    };
  }
  for (const half of ['lat', 'lon']) {
    const tok = pair[half];
    tok.segs.forEach((seg, i) => {
      const ctx = ctxFor(seg);
      const det = {
        id: uid('d'), fileId: file.id, pageNum: ctx.pageRec.num,
        rects: rectsForRange(ctx.spans, seg.start, seg.end),
        rowId: row.id, half, raw: tok.raw,
        span: [seg.start, seg.end],
      };
      state.dets.set(det.id, det);
      ctx.pageRec.dets.push(det.id);
      if (i === 0) row.src[half + 'Det'] = det.id;
      else row.src.extraDets.push(det.id);
    });
  }
  state.rows.push(row);
}

// Remove rows (and detections) from state; callers re-render. With suppress
// (default), detection locations are remembered so re-scans don't resurrect them.
function removeRows(ids, { suppress = true } = {}) {
  for (const row of state.rows) {
    if (!ids.has(row.id) || !row.src) continue;
    for (const detId of [row.src.latDet, row.src.lonDet, ...(row.src.extraDets || [])]) {
      if (!detId) continue;
      const det = state.dets.get(detId);
      if (det) {
        const file = state.files.find((f) => f.id === det.fileId);
        const pageRec = file?.pages.find((p) => p.num === det.pageNum);
        if (pageRec) pageRec.dets = pageRec.dets.filter((d) => d !== detId);
        if (suppress && det.span) {
          state.suppressed.add(locKey(det.fileId, det.pageNum, det.half, det.span[0]));
        }
      }
      state.dets.delete(detId);
    }
  }
  state.rows = state.rows.filter((r) => !ids.has(r.id));
  for (const id of ids) state.selected.delete(id);
  if (!state.rows.some((r) => r.id === state.activeRow)) state.activeRow = null;
}

function renderAll() {
  renderFileList();
  renderPages();
  renderTable();
  refreshCounts();
}

// ---------------------------------------------------------------------------
// File list
// ---------------------------------------------------------------------------

function renderFileList() {
  fileListEl.innerHTML = '';
  if (state.files.length === 0) {
    fileListEl.innerHTML = '<div class="empty-hint muted">No PDFs loaded</div>';
    return;
  }
  for (const f of state.files) {
    const nDet = f.pages.reduce((a, p) => a + p.dets.length, 0);
    const el = document.createElement('div');
    const override = f.intensity != null;
    el.className = 'file-entry' + (f.id === state.currentFile ? ' current' : '') + (override ? ' net-override' : '');
    const meta = f.error
      ? `<span class="err">error: ${escapeHtml(f.error)}</span>`
      : `<span class="${nDet ? 'count' : 'zero'}">${nDet} coord${nDet === 1 ? '' : 's'}</span> · ${f.numPages} p.`;
    el.innerHTML = `<div class="fname">${escapeHtml(f.name)}</div><div class="fmeta">${meta}</div>`;
    // Per-PDF detection-net override, so a stubborn document can get a more
    // aggressive net than the rest of the batch.
    if (!f.error) el.appendChild(buildFileNetControl(f));
    el.addEventListener('click', () => {
      if (state.currentFile !== f.id) {
        state.currentFile = f.id;
        renderFileList();
        renderPages();
      }
    });
    fileListEl.appendChild(el);
  }
}

// The per-PDF net picker shown on each file entry. "Auto" follows the global
// toolbar net; 1–7 pin this PDF to its own level. Changing it triggers an
// edit-preserving re-scan; only this PDF's net (and so its detections) differs.
function buildFileNetControl(file) {
  const label = document.createElement('label');
  label.className = 'file-net';
  label.title =
    'Detection net for this PDF only. "Auto" follows the global Net slider; ' +
    'pick a higher level to hunt this PDF more aggressively (or a lower one to be stricter).';
  const span = document.createElement('span');
  span.className = 'file-net-label';
  span.textContent = 'Net';
  const sel = document.createElement('select');
  sel.className = 'file-net-sel';
  const opts = [['', `Auto (${intensityName(state.intensity)})`]];
  for (let l = 1; l <= 7; l++) opts.push([String(l), `${l} · ${intensityName(l)}`]);
  sel.innerHTML = opts
    .map(([v, t]) => `<option value="${v}">${escapeHtml(t)}</option>`)
    .join('');
  sel.value = file.intensity != null ? String(file.intensity) : '';
  // Keep the entry's click (switch-current-file) from firing when using the picker.
  sel.addEventListener('click', (e) => e.stopPropagation());
  sel.addEventListener('change', (e) => {
    e.stopPropagation();
    onFileNetChange(file, sel.value);
  });
  label.append(span, sel);
  return label;
}

async function onFileNetChange(file, value) {
  const next = value === '' ? null : Number(value);
  if (next === file.intensity) return;
  if (state.busy) {
    renderFileList(); // revert the picker to the stored value
    setStatus('Busy — try again when scanning finishes.');
    return;
  }
  file.intensity = next;
  const desc = next == null
    ? `${file.name}: net back to Auto (global ${intensityName(state.intensity)})`
    : `${file.name}: net set to ${next} · ${intensityName(next)}`;
  await rescanAll(desc);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// PDF pages + highlights
// ---------------------------------------------------------------------------

function renderPages() {
  if (pageObserver) pageObserver.disconnect();
  pagesEl.innerHTML = '';
  const file = state.files.find((f) => f.id === state.currentFile);
  const empty = $('#pdf-empty');
  if (!file || file.error) {
    empty.style.display = '';
    return;
  }
  const pages = file.pages.filter((p) => state.showAll || p.dets.length > 0);
  empty.style.display = pages.length ? 'none' : '';

  pageObserver = new IntersectionObserver(onPageIntersect, {
    root: $('#pages-scroll'), rootMargin: '600px 0px',
  });

  for (const pageRec of pages) {
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.page = pageRec.num;
    wrap.style.width = `${Math.round(pageRec.w * state.zoom)}px`;
    wrap.style.height = `${Math.round(pageRec.h * state.zoom)}px`;

    const label = document.createElement('div');
    label.className = 'page-label';
    label.textContent = `${file.name} — page ${pageRec.num}${pageRec.dets.length ? ` · ${pageRec.dets.length} hit${pageRec.dets.length === 1 ? '' : 's'}` : ''}`;
    wrap.appendChild(label);

    const viewport = pageRec.proxy.getViewport({ scale: state.zoom });
    for (const detId of pageRec.dets) {
      const det = state.dets.get(detId);
      if (!det) continue;
      for (const rect of det.rects) {
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(rect);
        const hl = document.createElement('div');
        hl.className = 'hl';
        hl.dataset.det = det.id;
        hl.title = `${det.raw}  (${det.half === 'lat' ? 'latitude' : 'longitude'})`;
        hl.style.left = `${Math.min(x1, x2) - 2}px`;
        hl.style.top = `${Math.min(y1, y2) - 1}px`;
        hl.style.width = `${Math.abs(x2 - x1) + 4}px`;
        hl.style.height = `${Math.abs(y2 - y1) + 2}px`;
        hl.addEventListener('click', () => selectRowFromDet(det.id));
        wrap.appendChild(hl);
      }
    }

    pagesEl.appendChild(wrap);
    pageObserver.observe(wrap);
  }
  markActiveHighlights();
}

function onPageIntersect(entries) {
  const file = state.files.find((f) => f.id === state.currentFile);
  if (!file) return;
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const wrap = entry.target;
    const zoomKey = String(state.zoom);
    if (wrap.dataset.rendered === zoomKey) continue;
    const pageRec = file.pages.find((p) => p.num === Number(wrap.dataset.page));
    if (!pageRec) continue;
    wrap.dataset.rendered = zoomKey;
    renderPageCanvas(wrap, pageRec).catch(() => { wrap.dataset.rendered = ''; });
  }
}

async function renderPageCanvas(wrap, pageRec) {
  const viewport = pageRec.proxy.getViewport({ scale: state.zoom });
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${Math.round(viewport.width)}px`;
  canvas.style.height = `${Math.round(viewport.height)}px`;
  await pageRec.proxy.render({
    canvasContext: canvas.getContext('2d'),
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
  }).promise;
  const old = wrap.querySelector('canvas');
  if (old) old.remove();
  wrap.insertBefore(canvas, wrap.firstChild);
}

// ---------------------------------------------------------------------------
// Selection & two-way jumping
// ---------------------------------------------------------------------------

function selectRowFromDet(detId) {
  const det = state.dets.get(detId);
  if (!det) return;
  const idx = state.rows.findIndex((r) => r.id === det.rowId);
  if (idx < 0) return;
  setActiveRow(det.rowId, { scrollCsv: true, scrollPdf: false });
  state.selected = new Set([det.rowId]);
  state.anchor = det.rowId;
  refreshRowClasses();
}

function setActiveRow(rowId, { scrollCsv = false, scrollPdf = false } = {}) {
  state.activeRow = rowId;
  refreshRowClasses();
  markActiveHighlights();

  if (scrollCsv) {
    const tr = tbodyEl.querySelector(`tr[data-row="${rowId}"]`);
    if (tr) tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  if (scrollPdf) {
    const row = state.rows.find((r) => r.id === rowId);
    if (!row || !row.src) return;
    const jump = () => {
      const detId = row.src.latDet || row.src.lonDet;
      const el = detId && pagesEl.querySelector(`[data-det="${detId}"]`);
      // A hidden highlight can't be scrolled to — aim for its page instead.
      const target = el && (state.showHighlights ? el : el.closest('.page-wrap'));
      if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    if (state.currentFile !== row.src.fileId) {
      state.currentFile = row.src.fileId;
      renderFileList();
      renderPages();
      requestAnimationFrame(jump);
    } else {
      jump();
    }
  }
}

function markActiveHighlights() {
  const row = state.rows.find((r) => r.id === state.activeRow);
  const active = new Set();
  if (row && row.src) {
    if (row.src.latDet) active.add(row.src.latDet);
    if (row.src.lonDet) active.add(row.src.lonDet);
    for (const d of row.src.extraDets || []) active.add(d);
  }
  for (const el of pagesEl.querySelectorAll('.hl')) {
    el.classList.toggle('active', active.has(el.dataset.det));
  }
}

function refreshRowClasses() {
  for (const tr of tbodyEl.querySelectorAll('tr')) {
    tr.classList.toggle('selected', state.selected.has(tr.dataset.row));
    tr.classList.toggle('active', tr.dataset.row === state.activeRow);
  }
  const n = state.selected.size;
  $('#sel-info').textContent = n ? `${n} row${n === 1 ? '' : 's'} selected` : '';
}

// ---------------------------------------------------------------------------
// CSV table
// ---------------------------------------------------------------------------

function coordColumns() {
  switch (state.fmt) {
    case 'dms':
      return [
        { field: 'lat', mode: 'dms', label: 'Latitude (DMS)' },
        { field: 'lon', mode: 'dms', label: 'Longitude (DMS)' },
      ];
    case 'both':
      return [
        { field: 'lat', mode: 'dd', label: 'Latitude (DD)' },
        { field: 'lon', mode: 'dd', label: 'Longitude (DD)' },
        { field: 'lat', mode: 'dms', label: 'Latitude (DMS)' },
        { field: 'lon', mode: 'dms', label: 'Longitude (DMS)' },
      ];
    default:
      return [
        { field: 'lat', mode: 'dd', label: 'Latitude (DD)' },
        { field: 'lon', mode: 'dd', label: 'Longitude (DD)' },
      ];
  }
}

function cellText(row, col) {
  const raw = col.field === 'lat' ? row.latRaw : row.lonRaw;
  if (raw != null) return col.mode === 'dd' || state.fmt !== 'both' ? raw : '';
  const dd = row[col.field];
  if (dd == null) return '';
  return col.mode === 'dms' ? formatDMS(dd, col.field) : formatDD(dd);
}

// Keep the fill-tool column picker in sync with the data columns.
function renderFillCols() {
  const sel = $('#fill-col');
  const prev = sel.value;
  sel.innerHTML =
    state.cols
      .map((name, i) => `<option value="${i}">${escapeHtml(name.trim() || `Col ${i + 1}`)}</option>`)
      .join('') +
    (state.notesOn ? `<option value="notes">Notes</option>` : '');
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function renderTable() {
  const cols = coordColumns();

  // Header
  theadEl.innerHTML = '';
  const hr = document.createElement('tr');
  hr.innerHTML =
    `<th class="rownum">#</th>` +
    state.cols
      .map((name, i) =>
        `<th><input data-h="${i}" value="${escapeHtml(name)}" title="Column ${i + 1} header (editable)"/></th>`)
      .join('') +
    cols.map((c) => `<th>${c.label}</th>`).join('') +
    `<th class="srcinfo" title="Where the coordinate was found (not exported)">source</th>` +
    (state.notesOn ? `<th class="notescol" title="LLM-filled Notes column (exported)">Notes</th>` : '');
  theadEl.appendChild(hr);

  // Body
  tbodyEl.innerHTML = '';
  for (const row of state.rows) {
    tbodyEl.appendChild(buildRowEl(row, cols));
  }
  $('#csv-empty').style.display = state.rows.length ? 'none' : '';
  const flagged = state.rows.filter((r) => r.llm && r.llm.del).length;
  const delFlaggedBtn = $('#btn-del-flagged');
  delFlaggedBtn.classList.toggle('hidden', flagged === 0);
  delFlaggedBtn.textContent = `🗑 Delete Flagged (${flagged})`;
  renderFillCols();
  refreshRowClasses();
  positionFillHandle();
}

function buildRowEl(row, cols) {
  const tr = document.createElement('tr');
  tr.dataset.row = row.id;

  const idx = state.rows.indexOf(row);
  const tdNum = document.createElement('td');
  tdNum.className = 'rownum';
  tdNum.textContent = idx + 1;
  tr.appendChild(tdNum);

  state.cols.forEach((_, i) => {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.value = cellVal(row, i);
    input.dataset.cell = String(i);
    td.appendChild(input);
    tr.appendChild(td);
  });

  cols.forEach((col, i) => {
    const td = document.createElement('td');
    td.className = 'coord';
    const input = document.createElement('input');
    input.value = cellText(row, col);
    input.dataset.field = col.field;
    input.dataset.mode = col.mode;
    input.dataset.col = String(i);
    const raw = col.field === 'lat' ? row.latRaw : row.lonRaw;
    if (raw != null) input.classList.add('invalid');
    input.placeholder = col.mode === 'dms' ? `41°24'12"N` : '41.403';
    td.appendChild(input);
    tr.appendChild(td);
  });

  const tdSrc = document.createElement('td');
  tdSrc.className = 'srcinfo';
  if (row.llm && row.llm.del) {
    const badge = document.createElement('span');
    badge.className = 'llm-badge del';
    badge.textContent = '🗑';
    badge.dataset.row = row.id;
    badge.title =
      `LLM flagged this row as a false positive (not a real coordinate).` +
      `${row.llm.note ? `\n${row.llm.note}` : ''}` +
      `\nClick to delete the row.\n(LLM output — verify yourself)`;
    tdSrc.appendChild(badge);
  }
  if (row.llm && row.llm.verdict) {
    const badge = document.createElement('span');
    const verdict = row.llm.verdict;
    badge.className = `llm-badge ${verdict}`;
    badge.textContent = verdict === 'ok' ? '✓' : verdict === 'mismatch' ? '⚠' : '?';
    badge.dataset.row = row.id;
    let tip = `LLM verdict: ${verdict}`;
    if (row.llm.note) tip += `\n${row.llm.note}`;
    if (verdict === 'mismatch' && (row.llm.lat != null || row.llm.lon != null)) {
      tip += `\nSuggested: ${row.llm.lat ?? '(keep lat)'}, ${row.llm.lon ?? '(keep lon)'}\nClick to apply the suggestion.`;
    }
    tip += '\n(LLM output — verify yourself)';
    badge.title = tip;
    tdSrc.appendChild(badge);
  }
  if (row.src) {
    const f = state.files.find((x) => x.id === row.src.fileId);
    tdSrc.appendChild(document.createTextNode(`${f ? f.name : '?'} p.${row.src.pageNum}`));
    tdSrc.title = 'Click to show in PDF';
  } else {
    tdSrc.appendChild(document.createTextNode('—'));
  }
  tr.appendChild(tdSrc);

  if (state.notesOn) {
    const tdNotes = document.createElement('td');
    tdNotes.className = 'notescol';
    const input = document.createElement('input');
    input.value = row.notes || '';
    input.dataset.field = 'notes';
    tdNotes.appendChild(input);
    tr.appendChild(tdNotes);
  }
  return tr;
}

// Re-sync every coord cell of one row from state (after an edit).
function refreshRowCoordCells(tr, row) {
  const cols = coordColumns();
  for (const input of tr.querySelectorAll('td.coord input')) {
    const col = cols[Number(input.dataset.col)];
    if (document.activeElement === input) continue;
    input.value = cellText(row, col);
    const raw = col.field === 'lat' ? row.latRaw : row.lonRaw;
    input.classList.toggle('invalid', raw != null && input.value !== '');
  }
}

// ---------------------------------------------------------------------------
// Table events (delegated)
// ---------------------------------------------------------------------------

theadEl.addEventListener('change', (e) => {
  const h = e.target.dataset.h;
  if (h != null) {
    state.cols[Number(h)] = e.target.value;
    renderFillCols();
    persistSoon();
  }
});

tbodyEl.addEventListener('change', (e) => {
  const input = e.target;
  const tr = input.closest('tr');
  const row = state.rows.find((r) => r.id === tr?.dataset.row);
  if (!row) return;
  const field = input.dataset.field;

  if (input.dataset.cell != null) {
    if (!row.cells) row.cells = emptyCells();
    row.cells[Number(input.dataset.cell)] = input.value;
    persistSoon();
    return;
  }
  if (field === 'notes') {
    row.notes = input.value;
    persistSoon();
    return;
  }
  // Coordinate cell: auto-clean whatever was typed.
  const text = input.value.trim();
  const rawKey = field === 'lat' ? 'latRaw' : 'lonRaw';
  if (text === '') {
    row[field] = null;
    row[rawKey] = null;
  } else {
    const dd = parseSingle(text, field);
    if (dd != null) {
      row[field] = dd;
      row[rawKey] = null;
    } else {
      row[field] = null;
      row[rawKey] = text; // keep what they typed, flag it
    }
  }
  input.classList.toggle('invalid', row[rawKey] != null);
  const col = coordColumns()[Number(input.dataset.col)];
  if (row[rawKey] == null) input.value = cellText(row, col);
  refreshRowCoordCells(tr, row);
  persistSoon();
});

// Click a row -> make it active and jump to its PDF spot.
tbodyEl.addEventListener('click', (e) => {
  // Deletion flag badge: offer to delete the flagged row.
  if (e.target.classList.contains('llm-badge') && e.target.classList.contains('del')) {
    const row = state.rows.find((r) => r.id === e.target.dataset.row);
    if (row) {
      const ok = confirm(
        `The LLM flagged this row as a false positive.\n\n` +
        `${row.llm.note || ''}\n\nDelete the row?\nLLM output can be wrong — verify against the PDF first.`
      );
      if (ok) {
        removeRows(new Set([row.id]));
        renderAll();
        persistSoon();
      }
    }
    return;
  }

  // Mismatch badge: offer to apply the LLM's suggested coordinates.
  if (e.target.classList.contains('llm-badge')) {
    const row = state.rows.find((r) => r.id === e.target.dataset.row);
    if (row?.llm?.verdict === 'mismatch' && (row.llm.lat != null || row.llm.lon != null)) {
      const ok = confirm(
        `Apply the LLM's suggested coordinates to this row?\n\n` +
        `Latitude:  ${row.llm.lat ?? '(keep current)'}\n` +
        `Longitude: ${row.llm.lon ?? '(keep current)'}\n\n` +
        `${row.llm.note || ''}\n\nLLM output can be wrong — verify against the PDF.`
      );
      if (ok) {
        if (row.llm.lat != null) { row.lat = row.llm.lat; row.latRaw = null; }
        if (row.llm.lon != null) { row.lon = row.llm.lon; row.lonRaw = null; }
        row.llm = { ...row.llm, verdict: 'ok', note: 'LLM suggestion applied — verify manually.' };
        renderTable();
        persistSoon();
      }
      return;
    }
  }

  const tr = e.target.closest('tr');
  if (!tr) return;
  const rowId = tr.dataset.row;

  if (e.target.classList.contains('rownum')) {
    const ids = state.rows.map((r) => r.id);
    if (e.shiftKey && state.anchor) {
      const a = ids.indexOf(state.anchor);
      const b = ids.indexOf(rowId);
      state.selected = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (e.ctrlKey || e.metaKey) {
      if (state.selected.has(rowId)) state.selected.delete(rowId);
      else state.selected.add(rowId);
      state.anchor = rowId;
    } else {
      state.selected = new Set([rowId]);
      state.anchor = rowId;
    }
    refreshRowClasses();
  }

  if (rowId !== state.activeRow) {
    setActiveRow(rowId, { scrollPdf: true });
  } else if (e.target.classList.contains('srcinfo')) {
    setActiveRow(rowId, { scrollPdf: true });
  }
});

// Ctrl+D: copy the value from the cell above (quick fill-down).
tbodyEl.addEventListener('keydown', (e) => {
  if (!(e.key === 'd' && (e.ctrlKey || e.metaKey))) return;
  const input = e.target;
  if (input.tagName !== 'INPUT') return;
  e.preventDefault();
  const tr = input.closest('tr');
  const prev = tr.previousElementSibling;
  if (!prev) return;
  const idx = [...tr.querySelectorAll('input')].indexOf(input);
  const src = [...prev.querySelectorAll('input')][idx];
  if (!src) return;
  input.value = src.value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});

// ---------------------------------------------------------------------------
// Excel-style drag-to-fill: drag the handle at a focused cell's bottom-right
// to copy its value over every cell swept. Works for data/coord/Notes columns.
// ---------------------------------------------------------------------------

const csvScroll = $('#csv-scroll');
const fillHandle = $('#fill-handle');

let fillAnchor = null; // {rowId, col} — the cell the handle is attached to
let filling = null;    // active drag: {col, srcIndex, targetIndex, value, lastX, lastY}
let fillScrollTimer = null;

// A stable descriptor of a column, derived from one of its cell inputs, so the
// same column can be located in any other row.
function colDescOf(input) {
  if (input.dataset.cell != null) return { kind: 'cell', index: Number(input.dataset.cell) };
  if (input.dataset.field === 'notes') return { kind: 'notes' };
  if (input.dataset.col != null) return { kind: 'coord', field: input.dataset.field, colIndex: Number(input.dataset.col) };
  return null;
}

function inputInRow(tr, col) {
  if (!tr) return null;
  if (col.kind === 'cell') return tr.querySelector(`td input[data-cell="${col.index}"]`);
  if (col.kind === 'notes') return tr.querySelector('td.notescol input');
  if (col.kind === 'coord') return tr.querySelector(`td.coord input[data-col="${col.colIndex}"]`);
  return null;
}

// Park the handle over the bottom-right corner of the anchored cell. Positions
// in the scroll container's content coordinates so it rides along on scroll.
function positionFillHandle() {
  if (!fillHandle) return;
  const tr = fillAnchor && tbodyEl.querySelector(`tr[data-row="${fillAnchor.rowId}"]`);
  const td = tr && inputInRow(tr, fillAnchor.col)?.closest('td');
  if (!td) { fillAnchor = null; fillHandle.classList.remove('visible'); return; }
  const cRect = csvScroll.getBoundingClientRect();
  const tRect = td.getBoundingClientRect();
  fillHandle.style.left = `${tRect.right - cRect.left + csvScroll.scrollLeft - 4}px`;
  fillHandle.style.top = `${tRect.bottom - cRect.top + csvScroll.scrollTop - 4}px`;
  fillHandle.classList.add('visible');
}

// Focusing a cell moves the handle to it.
tbodyEl.addEventListener('focusin', (e) => {
  if (e.target.tagName !== 'INPUT') return;
  const col = colDescOf(e.target);
  if (!col) { fillAnchor = null; positionFillHandle(); return; }
  fillAnchor = { rowId: e.target.closest('tr').dataset.row, col };
  positionFillHandle();
});

function fillRangeRows() {
  const a = Math.min(filling.srcIndex, filling.targetIndex);
  const b = Math.max(filling.srcIndex, filling.targetIndex);
  return state.rows.slice(a, b + 1);
}

function paintFillPreview() {
  for (const td of tbodyEl.querySelectorAll('td.fill-target')) td.classList.remove('fill-target');
  for (const row of fillRangeRows()) {
    const tr = tbodyEl.querySelector(`tr[data-row="${row.id}"]`);
    inputInRow(tr, filling.col)?.closest('td')?.classList.add('fill-target');
  }
}

// Which row is the pointer over? Falls back to the first/last row when the
// pointer is dragged past the ends of the list.
function updateFillTarget(x, y) {
  if (!filling) return;
  const el = document.elementFromPoint(x, y);
  const tr = el && el.closest && el.closest('#csv-table tbody tr');
  if (tr && tr.dataset.row) {
    const idx = state.rows.findIndex((r) => r.id === tr.dataset.row);
    if (idx >= 0) filling.targetIndex = idx;
  } else {
    const rows = [...tbodyEl.querySelectorAll('tr')];
    if (rows.length) {
      if (y >= rows[rows.length - 1].getBoundingClientRect().bottom) filling.targetIndex = state.rows.length - 1;
      else if (y <= rows[0].getBoundingClientRect().top) filling.targetIndex = 0;
    }
  }
  paintFillPreview();
}

// Auto-scroll the table while the pointer sits near its top/bottom edge, so a
// fill can run far past the visible rows.
function fillAutoScroll(y) {
  const rect = csvScroll.getBoundingClientRect();
  const EDGE = 30;
  const dir = y > rect.bottom - EDGE ? 1 : y < rect.top + EDGE ? -1 : 0;
  if (dir === 0) { stopFillAutoScroll(); return; }
  if (fillScrollTimer) return;
  fillScrollTimer = setInterval(() => {
    csvScroll.scrollTop += dir * 14;
    if (filling) updateFillTarget(filling.lastX, filling.lastY);
  }, 30);
}

function stopFillAutoScroll() {
  if (fillScrollTimer) { clearInterval(fillScrollTimer); fillScrollTimer = null; }
}

function onFillMove(e) {
  if (!filling) return;
  filling.lastX = e.clientX;
  filling.lastY = e.clientY;
  updateFillTarget(e.clientX, e.clientY);
  fillAutoScroll(e.clientY);
}

function onFillUp() {
  window.removeEventListener('mousemove', onFillMove);
  window.removeEventListener('mouseup', onFillUp);
  stopFillAutoScroll();
  csvScroll.classList.remove('filling');
  fillHandle.style.pointerEvents = '';
  const f = filling;
  filling = null;
  for (const td of tbodyEl.querySelectorAll('td.fill-target')) td.classList.remove('fill-target');
  if (!f) return;
  const a = Math.min(f.srcIndex, f.targetIndex);
  const b = Math.max(f.srcIndex, f.targetIndex);
  const rows = state.rows.slice(a, b + 1);
  if (rows.length <= 1) return; // no drag — nothing to fill
  const ids = new Set(rows.map((r) => r.id));
  fillColumn(ids, f.col, f.value);
  const n = rows.length - 1;
  setStatus(`Filled ${n} cell${n === 1 ? '' : 's'} by dragging.`);
}

fillHandle.addEventListener('mousedown', (e) => {
  if (!fillAnchor) return;
  e.preventDefault(); // keep focus (and the handle) on the source cell
  const srcTr = tbodyEl.querySelector(`tr[data-row="${fillAnchor.rowId}"]`);
  const srcInput = inputInRow(srcTr, fillAnchor.col);
  const srcIndex = state.rows.findIndex((r) => r.id === fillAnchor.rowId);
  if (!srcInput || srcIndex < 0) return;
  filling = {
    col: fillAnchor.col, srcIndex, targetIndex: srcIndex,
    value: srcInput.value, lastX: e.clientX, lastY: e.clientY,
  };
  csvScroll.classList.add('filling');
  fillHandle.style.pointerEvents = 'none'; // let elementFromPoint see the rows
  window.addEventListener('mousemove', onFillMove);
  window.addEventListener('mouseup', onFillUp);
});

// Write one value into a single column of the given rows, parsing coordinate
// columns the same way a manual edit would.
function fillColumn(rowIds, col, value) {
  for (const row of state.rows) {
    if (!rowIds.has(row.id)) continue;
    if (col.kind === 'cell') {
      if (!row.cells) row.cells = emptyCells();
      row.cells[col.index] = value;
    } else if (col.kind === 'notes') {
      row.notes = value;
    } else if (col.kind === 'coord') {
      const rawKey = col.field === 'lat' ? 'latRaw' : 'lonRaw';
      const text = String(value).trim();
      if (text === '') {
        row[col.field] = null; row[rawKey] = null;
      } else {
        const dd = parseSingle(text, col.field);
        if (dd != null) { row[col.field] = dd; row[rawKey] = null; }
        else { row[col.field] = null; row[rawKey] = text; }
      }
    }
  }
  renderTable();
  persistSoon();
}

// ---------------------------------------------------------------------------
// Toolbar / tools
// ---------------------------------------------------------------------------

// Electron returns file paths (strings); the web shim returns {name, data} specs.
function toSpecs(files) {
  return files.map((f) =>
    typeof f === 'string' ? { path: f, name: f.split(/[\\/]/).pop() } : f);
}

$('#btn-open-folder').addEventListener('click', async () => {
  const res = await api.chooseFolder();
  if (!res) return;
  if (res.files.length === 0) { setStatus('No PDFs found in that folder.'); return; }
  await loadFiles(toSpecs(res.files));
});

$('#btn-open-files').addEventListener('click', async () => {
  const res = await api.choosePdfs();
  if (!res) return;
  await loadFiles(toSpecs(res.files));
});

for (const radio of document.querySelectorAll('input[name="fmt"]')) {
  radio.addEventListener('change', () => {
    state.fmt = radio.value;
    renderTable();
    persistSoon();
  });
}

$('#chk-all-pages').addEventListener('change', (e) => {
  state.showAll = e.target.checked;
  renderPages();
  persistSoon();
});

$('#chk-highlights').addEventListener('change', (e) => {
  state.showHighlights = e.target.checked;
  pagesEl.classList.toggle('no-hl', !state.showHighlights);
  persistSoon();
});

$('#btn-zoom-in').addEventListener('click', () => setZoom(state.zoom + 0.2));
$('#btn-zoom-out').addEventListener('click', () => setZoom(state.zoom - 0.2));

function setZoom(z) {
  state.zoom = Math.min(3, Math.max(0.6, Math.round(z * 10) / 10));
  $('#zoom-level').textContent = `${Math.round(state.zoom * 100)}%`;
  renderPages();
  persistSoon();
}

// ---------------------------------------------------------------------------
// Regex intensity slider
// ---------------------------------------------------------------------------

const intensityEl = $('#intensity');

function intensityName(level) {
  return (INTENSITY_LABELS[level] || '').split(' — ')[0];
}

function syncIntensityUi() {
  intensityEl.value = String(state.intensity);
  $('#intensity-name').textContent = intensityName(state.intensity);
  intensityEl.title = INTENSITY_LABELS[state.intensity] || '';
}

intensityEl.addEventListener('input', () => {
  $('#intensity-name').textContent = intensityName(Number(intensityEl.value));
  intensityEl.title = INTENSITY_LABELS[Number(intensityEl.value)] || '';
});

intensityEl.addEventListener('change', async () => {
  const level = Number(intensityEl.value);
  if (level === state.intensity) return;
  if (state.busy) {
    syncIntensityUi();
    setStatus('Busy — try again when scanning finishes.');
    return;
  }
  state.intensity = level;
  syncIntensityUi();
  await rescanAll();
});

// Re-run detection over every loaded PDF with its effective net (per-PDF
// override, else the global net). Rows whose detection still matches keep their
// edits; manual rows are untouched; rows the user deleted stay deleted
// (suppression keys). `msg` overrides the status line for a per-PDF change.
async function rescanAll(msg = null) {
  const scannable = state.files.filter((f) => !f.error && f.doc);
  if (scannable.length === 0) { renderTable(); persistSoon(); return; }
  state.busy = true;
  setStatus(msg || `Re-scanning with the "${intensityName(state.intensity)}" net…`, true);

  // Location keys of the current detection rows -> row, for edit reuse.
  const reuse = new Map();
  const detRows = new Set();
  for (const row of state.rows) {
    if (!row.src) continue;
    if (!scannable.some((f) => f.id === row.src.fileId)) continue; // keep as-is
    detRows.add(row.id);
    for (const detId of [row.src.latDet, row.src.lonDet]) {
      const det = detId && state.dets.get(detId);
      if (det && det.span) reuse.set(locKey(det.fileId, det.pageNum, det.half, det.span[0]), row);
    }
  }

  // Strip the old detections of scannable files; keep manual rows and rows of
  // broken files in place (their relative order is preserved by re-adding
  // scan results first).
  const keptRows = state.rows.filter((r) => !detRows.has(r.id));
  state.rows = [];
  for (const file of scannable) {
    for (const pageRec of file.pages) {
      for (const detId of pageRec.dets) state.dets.delete(detId);
      pageRec.dets = [];
    }
  }

  try {
    for (const file of scannable) {
      let prevCtx = null;
      for (const pageRec of file.pages) {
        const tc = await pageRec.proxy.getTextContent();
        const { text, spans } = buildPageText(tc);
        const ctx = { pageRec, text, spans };
        scanPage(file, ctx, prevCtx, reuse);
        prevCtx = ctx;
      }
    }
  } finally {
    state.rows.push(...keptRows);
    state.selected.clear();
    state.anchor = null;
    if (!state.rows.some((r) => r.id === state.activeRow)) state.activeRow = null;
    state.busy = false;
  }
  renderAll();
  persistSoon();
}

$('#btn-add-row').addEventListener('click', () => {
  state.rows.push({
    id: uid('r'), cells: emptyCells(), notes: '', lat: null, lon: null,
    latRaw: null, lonRaw: null, src: null,
  });
  renderTable();
  refreshCounts();
  persistSoon();
  tbodyEl.lastElementChild?.scrollIntoView({ block: 'nearest' });
});

$('#btn-add-col').addEventListener('click', () => {
  state.cols.push(`Field ${state.cols.length + 1}`);
  for (const r of state.rows) {
    if (!r.cells) r.cells = [];
    while (r.cells.length < state.cols.length) r.cells.push('');
  }
  renderTable();
  persistSoon();
});

$('#btn-del-col').addEventListener('click', () => {
  if (state.cols.length <= 2) { setStatus('The first two data columns are permanent.'); return; }
  const idx = state.cols.length - 1;
  const hasData = state.rows.some((r) => cellVal(r, idx).trim());
  if (hasData && !confirm(`Column "${state.cols[idx]}" contains values — remove it and its data anyway?`)) return;
  state.cols.pop();
  for (const r of state.rows) {
    if (r.cells) r.cells = r.cells.slice(0, state.cols.length);
  }
  renderTable();
  persistSoon();
});

$('#btn-del-rows').addEventListener('click', () => {
  if (state.selected.size === 0) { setStatus('Select rows first (click the row numbers).'); return; }
  removeRows(new Set(state.selected));
  state.anchor = null;
  renderAll();
  persistSoon();
});

$('#btn-del-flagged').addEventListener('click', () => {
  const flagged = state.rows.filter((r) => r.llm && r.llm.del);
  if (flagged.length === 0) return;
  const ok = confirm(
    `Delete the ${flagged.length} row${flagged.length === 1 ? '' : 's'} the LLM flagged as false positives?\n\n` +
    `LLM output can be wrong — spot-check the flags before deleting.`
  );
  if (!ok) return;
  removeRows(new Set(flagged.map((r) => r.id)));
  renderAll();
  persistSoon();
  setStatus(`Deleted ${flagged.length} LLM-flagged row${flagged.length === 1 ? '' : 's'}.`);
});

// ---------------------------------------------------------------------------
// Remove duplicate coordinates
// ---------------------------------------------------------------------------

const dedupDialog = $('#dedup-dialog');

function dedupOpts() {
  return {
    sameCols: $('#dedup-samecols').checked,
    samePdf: $('#dedup-samepdf').checked,
  };
}

// Refresh the "N of M would be removed" preview and enable/disable the button.
function syncDedupPreview() {
  const n = findDuplicateRowIds(state.rows, dedupOpts()).length;
  const total = state.rows.length;
  $('#dedup-status').textContent = n === 0
    ? `No duplicate coordinates found among the ${total} row${total === 1 ? '' : 's'}.`
    : `${n} duplicate row${n === 1 ? '' : 's'} will be removed (of ${total}).`;
  $('#dedup-run').disabled = n === 0;
}

$('#btn-dedup').addEventListener('click', () => {
  if (state.rows.length === 0) { setStatus('Nothing to de-duplicate yet.'); return; }
  // The label references the current column-1/2 header names.
  const c1 = (state.cols[0] || 'Column 1').trim() || 'Column 1';
  const c2 = (state.cols[1] || 'Column 2').trim() || 'Column 2';
  $('#dedup-samecols-label').textContent = `Only when columns 1 & 2 (${c1} & ${c2}) also match`;
  syncDedupPreview();
  dedupDialog.showModal();
});

for (const id of ['dedup-samecols', 'dedup-samepdf']) {
  $(`#${id}`).addEventListener('change', syncDedupPreview);
}

$('#dedup-run').addEventListener('click', () => {
  const ids = findDuplicateRowIds(state.rows, dedupOpts());
  if (ids.length === 0) { syncDedupPreview(); return; }
  removeRows(new Set(ids));
  state.anchor = null;
  renderAll();
  persistSoon();
  setStatus(`Removed ${ids.length} duplicate coordinate row${ids.length === 1 ? '' : 's'}.`);
  dedupDialog.close();
});

function applyFill(rowIds, colKey, value) {
  let n = 0;
  for (const row of state.rows) {
    if (!rowIds.has(row.id)) continue;
    if (colKey === 'notes') {
      row.notes = value;
    } else {
      if (!row.cells) row.cells = emptyCells();
      row.cells[Number(colKey)] = value;
    }
    n++;
  }
  renderTable();
  persistSoon();
  setStatus(`Filled ${n} row${n === 1 ? '' : 's'}.`);
}

$('#btn-fill-range').addEventListener('click', () => {
  const from = parseInt($('#fill-from').value, 10);
  const to = parseInt($('#fill-to').value, 10);
  if (!from || !to) { setStatus('Enter a row range first (e.g. rows 2 – 23).'); return; }
  const [a, b] = [Math.min(from, to), Math.max(from, to)];
  const ids = new Set(state.rows.slice(a - 1, b).map((r) => r.id));
  applyFill(ids, $('#fill-col').value, $('#fill-value').value);
});

$('#btn-fill-selected').addEventListener('click', () => {
  if (state.selected.size === 0) { setStatus('Select rows first (click the row numbers).'); return; }
  applyFill(state.selected, $('#fill-col').value, $('#fill-value').value);
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv() {
  const cols = coordColumns();
  const header = [...state.cols, ...cols.map((c) => c.label)];
  if (state.notesOn) header.push('Notes');
  const lines = [header.map(csvEscape).join(',')];
  for (const row of state.rows) {
    const cells = [
      ...state.cols.map((_, i) => cellVal(row, i)),
      ...cols.map((c) => cellText(row, c)),
    ];
    if (state.notesOn) cells.push(row.notes || '');
    lines.push(cells.map(csvEscape).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

$('#btn-export').addEventListener('click', async () => {
  if (state.rows.length === 0) { setStatus('Nothing to export yet.'); return; }
  const saved = await api.saveCsv({
    defaultName: 'coordinates.csv',
    content: buildCsv(),
  });
  setStatus(saved ? `Saved ${saved}` : 'Export cancelled.');
});

// ---------------------------------------------------------------------------
// Save the current PDF with its highlights baked in (rendered pages + the
// yellow detection rectangles, re-assembled into a new PDF).
// ---------------------------------------------------------------------------

const HL_EXPORT_SCALE = 2; // render resolution: 144 dpi keeps text readable

async function renderHighlightedPage(pageRec) {
  const viewport = pageRec.proxy.getViewport({ scale: HL_EXPORT_SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d');
  await pageRec.proxy.render({ canvasContext: ctx, viewport }).promise;
  for (const detId of pageRec.dets) {
    const det = state.dets.get(detId);
    if (!det) continue;
    for (const rect of det.rects) {
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(rect);
      const [x, y] = [Math.min(x1, x2) - 2, Math.min(y1, y2) - 1];
      const [w, h] = [Math.abs(x2 - x1) + 4, Math.abs(y2 - y1) + 2];
      ctx.fillStyle = 'rgba(250, 204, 21, 0.42)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, w, h);
    }
  }
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
  if (!blob) throw new Error('Could not encode a page image');
  return {
    w: pageRec.w, h: pageRec.h,
    pw: canvas.width, ph: canvas.height,
    jpeg: new Uint8Array(await blob.arrayBuffer()),
  };
}

$('#btn-save-hl').addEventListener('click', async () => {
  if (state.busy) { setStatus('Busy — try again when the current job finishes.'); return; }
  const file = state.files.find((f) => f.id === state.currentFile);
  if (!file || file.error || !file.doc) { setStatus('Open a PDF first (the currently viewed PDF is saved).'); return; }
  state.busy = true;
  try {
    const pages = [];
    for (const pageRec of file.pages) {
      setStatus(`Rendering ${file.name} page ${pageRec.num}/${file.pages.length}…`, true);
      pages.push(await renderHighlightedPage(pageRec));
    }
    setStatus('Building PDF…', true);
    const bytes = buildImagePdf(pages);
    const saved = await api.savePdf({
      defaultName: file.name.replace(/\.pdf$/i, '') + '-highlighted.pdf',
      data: bytes,
    });
    setStatus(saved ? `Saved ${saved}` : 'Save cancelled.');
  } catch (err) {
    setStatus(`Could not save the highlighted PDF: ${err && err.message ? err.message : err}`);
  } finally {
    state.busy = false;
  }
});

// ---------------------------------------------------------------------------
// Drag & drop, divider, autoload
// ---------------------------------------------------------------------------

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const pdfs = [...(e.dataTransfer?.files || [])].filter((f) => /\.pdf$/i.test(f.name));
  if (pdfs.length === 0) return;
  const specs = [];
  for (const f of pdfs) specs.push({ name: f.name, path: null, data: await f.arrayBuffer() });
  await loadFiles(specs);
});

// Draggable divider between panels.
{
  const divider = $('#divider');
  const left = $('#left');
  let dragging = false;
  divider.addEventListener('mousedown', () => { dragging = true; document.body.style.cursor = 'col-resize'; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.min(Math.max(e.clientX, 280), window.innerWidth - 320);
    left.style.width = `${w}px`;
  });
  window.addEventListener('mouseup', () => { dragging = false; document.body.style.cursor = ''; });
}

api.onAutoload(async (paths) => {
  await appReady; // don't race the session restore
  loadFiles(paths.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() })));
});

// ---------------------------------------------------------------------------
// LLM Assist
// ---------------------------------------------------------------------------

const llmDialog = $('#llm-dialog');
const LLM_PREFS_KEY = 'coordrippr.llm.prefs';
let llmRunning = false;
let llmAbort = false;

function llmPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(LLM_PREFS_KEY)) || {}; } catch { /* fresh */ }
  p.keys = p.keys || {};
  p.models = p.models || {};
  p.urls = p.urls || {};
  // Retry-model settings are kept in their own per-provider maps so a provider
  // can serve as both the primary and the retry with different models/keys.
  p.retryModels = p.retryModels || {};
  p.retryUrls = p.retryUrls || {};
  p.retryKeys = p.retryKeys || {};
  return p;
}

function llmStatus(msg) {
  $('#llm-status').textContent = msg;
  // Mirror progress to the footer so the run can be watched with the dialog
  // closed (the user can close it without stopping the run).
  if (llmRunning && msg) setStatus(`✨ LLM Assist — ${msg.split('\n')[0]}`, true);
}

// Sentinel <option> value that means "let me type my own model ID".
const CUSTOM_MODEL_OPT = '__custom__';

function syncLlmProviderFields() {
  const prefs = llmPrefs();
  const id = $('#llm-provider').value;
  const p = PROVIDERS[id];
  const model = prefs.models[id] ?? p.model;
  $('#llm-model').value = model;
  fillModelSelect($('#llm-model-select'), $('#llm-model'), p, model);
  $('#llm-url').value = prefs.urls[id] ?? p.url;
  $('#llm-key').value = prefs.keys[id] ?? '';
  $('#llm-key').placeholder = p.keyHint || '';
  setKeyLink($('#llm-key-link'), p);
  // The primary provider drives whether the retry can reuse its key.
  syncRetryFields();
}

// Fill a model dropdown from the provider's presets plus "Custom…". Picks the
// current model if it's a preset, else Custom + reveals the free-text field.
function fillModelSelect(sel, input, p, model) {
  const models = p.models || [];
  const known = models.includes(model);
  sel.innerHTML =
    models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('') +
    `<option value="${CUSTOM_MODEL_OPT}">Custom…</option>`;
  sel.value = known ? model : CUSTOM_MODEL_OPT;
  input.hidden = sel.value !== CUSTOM_MODEL_OPT;
}

// The free-text model field is only shown when "Custom…" is picked; otherwise
// the dropdown alone drives the model value.
function onModelSelectChange(sel, input) {
  if (sel.value !== CUSTOM_MODEL_OPT) input.value = sel.value;
  input.hidden = sel.value !== CUSTOM_MODEL_OPT;
  if (sel.value === CUSTOM_MODEL_OPT) {
    input.focus();
    input.select();
  }
}

// Point an API-key "get a key" link at the provider's key page (or hide it).
function setKeyLink(link, p) {
  if (p.keyUrl) {
    link.textContent = `Get an API key from ${p.keyName || p.label}`;
    link.dataset.url = p.keyUrl;
    link.classList.remove('hidden');
  } else {
    link.textContent = '';
    delete link.dataset.url;
    link.classList.add('hidden');
  }
}

// Show/populate the "retry with a different model" fields. The retry can reuse
// the primary API key when it targets the same provider (unless a separate key
// is requested); a different provider always needs its own key.
function syncRetryFields() {
  // The second-model settings appear when any second-model feature is on:
  // "Retry unfinished rows" or "delete only when a second model agrees".
  const on = $('#llm-retry').checked || $('#llm-confirmdel').checked;
  $('#llm-retry-config').classList.toggle('hidden', !on);
  $('#llm-retry-hint').classList.toggle('hidden', on);
  if (!on) return;
  const prefs = llmPrefs();
  const primaryId = $('#llm-provider').value;
  const rid = $('#llm-retry-provider').value;
  const p = PROVIDERS[rid];
  const model = prefs.retryModels[rid] ?? p.model;
  $('#llm-retry-model').value = model;
  fillModelSelect($('#llm-retry-model-select'), $('#llm-retry-model'), p, model);
  $('#llm-retry-url').value = prefs.retryUrls[rid] ?? p.url;

  const sameProvider = rid === primaryId;
  // The "use a separate key" choice only matters for the same provider; a
  // different provider always needs its own key.
  $('#llm-retry-secondkey-wrap').classList.toggle('hidden', !sameProvider);
  const separateKey = !sameProvider || $('#llm-retry-secondkey').checked;
  $('#llm-retry-key-wrap').classList.toggle('hidden', !separateKey);
  if (separateKey) {
    $('#llm-retry-key').value = prefs.retryKeys[rid] ?? '';
    $('#llm-retry-key').placeholder = p.keyHint || '';
    setKeyLink($('#llm-retry-key-link'), p);
  }
}

function initLlmDialog() {
  const providerOptions = Object.entries(PROVIDERS)
    .map(([id, p]) => `<option value="${id}">${escapeHtml(p.label)}</option>`)
    .join('');
  const sel = $('#llm-provider');
  sel.innerHTML = providerOptions;
  $('#llm-retry-provider').innerHTML = providerOptions;
  const prefs = llmPrefs();
  if (prefs.provider && PROVIDERS[prefs.provider]) sel.value = prefs.provider;
  const scopeRadio = document.querySelector(`input[name="llm-scope"][value="${prefs.scope}"]`);
  if (scopeRadio) scopeRadio.checked = true;
  const sendModeRadio = document.querySelector(`input[name="llm-sendmode"][value="${prefs.sendMode}"]`);
  if (sendModeRadio) sendModeRadio.checked = true;
  $('#llm-files-all').addEventListener('click', () => setAllLlmFiles(true));
  $('#llm-files-none').addEventListener('click', () => setAllLlmFiles(false));
  if (prefs.extra != null) $('#llm-extra').value = prefs.extra;
  // Verification is always on — every sent row must come back with a badge —
  // so it is never restored to "off" from an old preference.
  $('#llm-verify').checked = true;
  if (prefs.genus != null) $('#llm-genus').checked = prefs.genus;
  if (prefs.species != null) $('#llm-species').checked = prefs.species;
  if (prefs.fill != null) $('#llm-fill').checked = prefs.fill;
  if (prefs.overwrite != null) $('#llm-overwrite').checked = prefs.overwrite;
  if (prefs.flagDelete != null) $('#llm-flagdel').checked = prefs.flagDelete;
  if (prefs.perPage != null) $('#llm-perpage').checked = prefs.perPage;
  $('#llm-concurrency').value = clampConcurrency(prefs.concurrency ?? DEFAULT_CONCURRENCY);
  $('#llm-concurrency').max = String(MAX_CONCURRENCY);
  $('#llm-delay').value = clampBatchDelay(prefs.batchDelay ?? DEFAULT_BATCH_DELAY);
  $('#llm-delay').max = String(MAX_BATCH_DELAY_MS);
  // Advanced: model temperature (off by default — provider default is used).
  if (prefs.tempOn != null) $('#llm-temp-on').checked = prefs.tempOn;
  $('#llm-temp').value = clampTemperature(prefs.temperature ?? DEFAULT_TEMPERATURE);
  $('#llm-temp').min = String(MIN_TEMPERATURE);
  $('#llm-temp').max = String(MAX_TEMPERATURE);
  syncTempState();
  $('#llm-temp-on').addEventListener('change', syncTempState);
  if (prefs.notes != null) $('#llm-notes').checked = prefs.notes;
  if (prefs.notesSpec) $('#llm-notes-spec').value = prefs.notesSpec;
  // Retry model settings.
  if (prefs.retry != null) $('#llm-retry').checked = prefs.retry;
  if (prefs.retryProvider && PROVIDERS[prefs.retryProvider]) $('#llm-retry-provider').value = prefs.retryProvider;
  if (prefs.retrySecondKey != null) $('#llm-retry-secondkey').checked = prefs.retrySecondKey;
  // The deletion follow-ups (auto-delete, second-model confirmation) are
  // deliberately NOT restored from prefs: both delete rows, so they must be
  // opted into per run.
  syncDeleteOpts();
  $('#llm-flagdel').addEventListener('change', syncDeleteOpts);
  $('#llm-autodel').addEventListener('change', (e) => {
    if (e.currentTarget.checked) $('#llm-confirmdel').checked = false; // mutually exclusive
    syncDeleteOpts();
  });
  $('#llm-confirmdel').addEventListener('change', (e) => {
    if (e.currentTarget.checked) $('#llm-autodel').checked = false; // mutually exclusive
    syncDeleteOpts();
  });
  syncPerPageState();
  for (const radio of document.querySelectorAll('input[name="llm-scope"]')) {
    radio.addEventListener('change', syncPerPageState);
  }
  syncNotesState();
  $('#llm-notes').addEventListener('change', syncNotesState);
  syncLlmProviderFields();
  sel.addEventListener('change', syncLlmProviderFields);
  $('#llm-model-select').addEventListener('change', (e) => onModelSelectChange(e.currentTarget, $('#llm-model')));
  $('#llm-key-link').addEventListener('click', (e) => {
    const url = e.currentTarget.dataset.url;
    if (url) api.openExternal(url);
  });
  // Retry wiring.
  $('#llm-retry').addEventListener('change', syncRetryFields);
  $('#llm-retry-provider').addEventListener('change', syncRetryFields);
  $('#llm-retry-secondkey').addEventListener('change', syncRetryFields);
  $('#llm-retry-model-select').addEventListener('change', (e) => onModelSelectChange(e.currentTarget, $('#llm-retry-model')));
  $('#llm-retry-key-link').addEventListener('click', (e) => {
    const url = e.currentTarget.dataset.url;
    if (url) api.openExternal(url);
  });
  $('#llm-preview').addEventListener('click', previewLlmPrompt);
}

// The two follow-ups to flagging (immediate auto-delete, or second-model
// confirmation) both need flagging on, and are mutually exclusive.
function syncDeleteOpts() {
  const flag = $('#llm-flagdel').checked;
  const auto = $('#llm-autodel');
  const confirm = $('#llm-confirmdel');
  if (!flag) { auto.checked = false; confirm.checked = false; }
  auto.disabled = !flag;
  confirm.disabled = !flag;
  // Checking the second-model delete option reveals the second-model settings.
  syncRetryFields();
}

// Per-page batching only applies when we're NOT sending the whole PDF.
function syncPerPageState() {
  const wholePdf = document.querySelector('input[name="llm-scope"]:checked').value === 'all';
  $('#llm-perpage').disabled = wholePdf;
}

function syncNotesState() {
  $('#llm-notes-spec').disabled = !$('#llm-notes').checked;
}

// Rebuild the LLM dialog's PDF checkbox list. Earlier choices are kept; new
// files default to checked (all sent unless opted out). Rowless files can't be sent.
function renderLlmFileList() {
  const box = $('#llm-files');
  const prev = new Map();
  for (const cb of box.querySelectorAll('input[type="checkbox"]')) {
    prev.set(cb.dataset.file, cb.checked);
  }
  box.innerHTML = '';
  const files = state.files.filter((f) => !f.error);
  if (files.length === 0) {
    box.innerHTML = '<span class="muted">No PDFs loaded.</span>';
    return;
  }
  const counts = new Map(); // fileId -> {rows, sent}
  for (const r of state.rows) {
    if (!r.src) continue;
    const c = counts.get(r.src.fileId) || { rows: 0, sent: 0 };
    c.rows++;
    if (r.llmSent) c.sent++;
    counts.set(r.src.fileId, c);
  }
  for (const f of files) {
    const c = counts.get(f.id) || { rows: 0, sent: 0 };
    const label = document.createElement('label');
    label.className = 'llm-file';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.file = f.id;
    cb.disabled = c.rows === 0;
    cb.checked = c.rows > 0 && (prev.get(f.id) ?? true);
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = f.name;
    const meta = document.createElement('span');
    meta.className = 'fmeta';
    meta.textContent =
      c.rows === 0 ? 'no rows' :
      c.sent === 0 ? `${c.rows} row${c.rows === 1 ? '' : 's'}` :
      c.sent === c.rows ? `${c.rows} row${c.rows === 1 ? '' : 's'} · all sent to LLM` :
      `${c.rows} rows · ${c.sent} already sent`;
    label.append(cb, name, meta);
    box.appendChild(label);
  }
}

function setAllLlmFiles(on) {
  for (const cb of document.querySelectorAll('#llm-files input[type="checkbox"]')) {
    if (!cb.disabled) cb.checked = on;
  }
}

// Coerce the concurrency field to a whole number within [1, MAX_CONCURRENCY],
// falling back to the default for blank/garbage input.
function clampConcurrency(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONCURRENCY;
  return Math.min(n, MAX_CONCURRENCY);
}

// Coerce the batch-delay field to whole milliseconds within [0, MAX_BATCH_DELAY_MS].
// Blank/garbage input means "no delay" (0), i.e. the steady-pool path.
function clampBatchDelay(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_BATCH_DELAY_MS);
}

// Coerce the temperature field into [MIN_TEMPERATURE, MAX_TEMPERATURE], falling
// back to the default for blank/garbage input.
function clampTemperature(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_TEMPERATURE;
  return Math.min(MAX_TEMPERATURE, Math.max(MIN_TEMPERATURE, n));
}

// The temperature value field is only editable when the "set temperature" box
// is ticked; otherwise the provider's own default is used (unchanged behaviour).
function syncTempState() {
  $('#llm-temp').disabled = !$('#llm-temp-on').checked;
}

function collectLlmSettings() {
  const id = $('#llm-provider').value;
  const s = {
    provider: id,
    kind: PROVIDERS[id].kind,
    model: $('#llm-model').value.trim(),
    url: $('#llm-url').value.trim(),
    key: $('#llm-key').value.trim(),
    scope: document.querySelector('input[name="llm-scope"]:checked').value,
    // Only rows never answered by an LLM go out (resend-all is the default).
    unsentOnly: document.querySelector('input[name="llm-sendmode"]:checked').value === 'unsent',
    // File ids the user ticked in the "PDFs to send" list.
    files: new Set(
      [...document.querySelectorAll('#llm-files input[type="checkbox"]')]
        .filter((cb) => cb.checked)
        .map((cb) => cb.dataset.file)
    ),
    perPage: $('#llm-perpage').checked,
    concurrency: clampConcurrency($('#llm-concurrency').value),
    batchDelay: clampBatchDelay($('#llm-delay').value),
    // Advanced: when off, temperature stays undefined so the request is byte-for-
    // byte what it was before (provider default). When on, a clamped value rides
    // along to both the primary and second model.
    tempOn: $('#llm-temp-on').checked,
    temperature: clampTemperature($('#llm-temp').value),
    extra: $('#llm-extra').value,
    verify: $('#llm-verify').checked,
    genus: $('#llm-genus').checked,
    species: $('#llm-species').checked,
    fill: $('#llm-fill').checked,
    overwrite: $('#llm-overwrite').checked,
    // Second-model delete confirmation implies flagging (model 1 must flag
    // before model 2 can confirm), and is exclusive with immediate auto-delete.
    confirmDelete: $('#llm-flagdel').checked && $('#llm-confirmdel').checked,
    flagDelete: $('#llm-flagdel').checked,
    autoDelete: $('#llm-flagdel').checked && $('#llm-autodel').checked && !$('#llm-confirmdel').checked,
    notes: $('#llm-notes').checked,
    notesSpec: $('#llm-notes-spec').value,
  };

  // Second-model settings, shared by "retry unfinished rows" and "delete only
  // when a second model agrees". When the second model is the same provider and
  // no separate key is requested it reuses the primary key; otherwise it uses
  // its own (a second key, or the other provider's key).
  const retryId = $('#llm-retry-provider').value;
  const retrySameProvider = retryId === id;
  const retrySecondKey = $('#llm-retry-secondkey').checked;
  const retrySeparateKey = !retrySameProvider || retrySecondKey;
  s.retry = $('#llm-retry').checked;
  s.retryProvider = retryId;
  s.retryKind = PROVIDERS[retryId].kind;
  s.retryModel = $('#llm-retry-model').value.trim();
  s.retryUrl = $('#llm-retry-url').value.trim();
  s.retryKey = retrySeparateKey ? $('#llm-retry-key').value.trim() : s.key;
  // Any feature that engages the second model.
  s.useSecondModel = s.retry || s.confirmDelete;

  const prefs = llmPrefs();
  prefs.provider = id;
  prefs.models[id] = s.model;
  prefs.urls[id] = s.url;
  prefs.keys[id] = s.key;
  prefs.scope = s.scope;
  prefs.sendMode = s.unsentOnly ? 'unsent' : 'all';
  prefs.perPage = s.perPage;
  prefs.concurrency = s.concurrency;
  prefs.batchDelay = s.batchDelay;
  prefs.tempOn = s.tempOn;
  prefs.temperature = s.temperature;
  prefs.extra = s.extra;
  prefs.verify = s.verify;
  prefs.genus = s.genus;
  prefs.species = s.species;
  prefs.fill = s.fill;
  prefs.overwrite = s.overwrite;
  prefs.flagDelete = s.flagDelete;
  prefs.notes = s.notes;
  prefs.notesSpec = s.notesSpec;
  prefs.retry = s.retry;
  prefs.retryProvider = retryId;
  prefs.retrySecondKey = retrySecondKey;
  prefs.retryModels[retryId] = s.retryModel;
  prefs.retryUrls[retryId] = s.retryUrl;
  if (retrySeparateKey) prefs.retryKeys[retryId] = $('#llm-retry-key').value.trim();
  localStorage.setItem(LLM_PREFS_KEY, JSON.stringify(prefs));
  return s;
}

// Rows grouped per file with the page numbers to send. Only ticked files; with
// unsentOnly, rows an LLM already answered are skipped (and counted for status).
function buildLlmWork({ scope, files, unsentOnly }) {
  const work = [];
  let skippedSent = 0;
  for (const file of state.files) {
    if (file.error || !files.has(file.id)) continue;
    const rows = [];
    state.rows.forEach((r, i) => {
      if (r.src && r.src.fileId === file.id) {
        if (unsentOnly && r.llmSent) { skippedSent++; return; }
        rows.push({
          id: r.id, num: i + 1, cells: [...(r.cells || [])],
          lat: r.lat != null ? Number(r.lat.toFixed(6)) : null,
          lon: r.lon != null ? Number(r.lon.toFixed(6)) : null,
          file: file.name, page: r.src.pageNum,
        });
      }
    });
    if (rows.length === 0) continue;
    const pageNums = file.pages
      .filter((p) => scope === 'all' || p.dets.length > 0)
      .map((p) => p.num);
    work.push({ file, rows, pageNums });
  }
  return { work, skippedSent };
}

async function pageTextFor(file, pageNum) {
  const pageRec = file.pages.find((p) => p.num === pageNum);
  if (!pageRec) return '';
  const tc = await pageRec.proxy.getTextContent();
  return buildPageText(tc).text;
}

function applyLlmResults(results, s, counts, meta) {
  const toDelete = new Set();
  for (const res of results) {
    const row = state.rows.find((r) => r.id === res.row);
    if (!row) continue;
    if (s.verify && res.verdict) {
      row.llm = { ...(row.llm || {}), verdict: res.verdict, note: res.note, lat: res.lat, lon: res.lon };
      counts[res.verdict]++;
    }
    if (s.fill || s.genus || s.species) {
      if (!row.cells) row.cells = emptyCells();
      res.cols.forEach((v, i) => {
        if (i >= state.cols.length) return;
        // Genus (col 1) and Species (col 2) are always a single word; the
        // dedicated toggles gate those columns, "Fill" gates the rest.
        const isGenus = i === 0 && s.genus;
        const isSpecies = i === 1 && s.species;
        if (!(s.fill || isGenus || isSpecies)) return;
        const val = (isGenus || isSpecies) ? oneWord(v) : v;
        if (!val) return;
        if (s.overwrite || !String(row.cells[i] || '').trim()) { row.cells[i] = val; counts.filled++; }
      });
    }
    if (s.notes && res.notesCol && (s.overwrite || !String(row.notes || '').trim())) {
      row.notes = res.notesCol;
      counts.noted++;
    }
    if (s.flagDelete && res.del) {
      if (s.autoDelete) {
        toDelete.add(row.id);
        counts.deleted++;
        const m = meta && meta.get(row.id);
        counts.deletedInfo.push(
          `#${m ? m.num : '?'} — ${row.lat ?? '(no lat)'}, ${row.lon ?? '(no lon)'}` +
          `${m ? ` (${m.file} p.${m.page})` : ''}: ${res.note || 'no reason given'}`
        );
      } else {
        row.llm = { ...(row.llm || {}), del: true, note: res.note || (row.llm && row.llm.note) || '' };
        counts.flagged++;
      }
    }
  }
  if (toDelete.size) removeRows(toDelete);
}

// Build the exact prompt the first request would send (system + user) from the
// current settings and show it. Uses the first real chunk when PDFs/rows are
// available, else a small illustrative example so the instructions still show.
async function previewLlmPrompt() {
  const s = collectLlmSettings();
  const perPage = s.perPage && s.scope !== 'all';
  const hasExtra = !!(s.extra && s.extra.trim());
  const allow = (s.fill || s.genus || s.species || hasExtra) && s.scope !== 'all';
  let chunk = null;
  if (s.files.size) {
    // Ignore the "unsent only" filter here so a real chunk shows even after a run.
    const { work } = buildLlmWork({ scope: s.scope, files: s.files, unsentOnly: false });
    if (work.length) {
      const w = work[0];
      const pages = [];
      for (const num of w.pageNums) {
        pages.push({ file: w.file.name, page: num, text: await pageTextFor(w.file, num) });
      }
      chunk = (perPage ? chunkPerPage(pages, w.rows) : chunkWork(pages, w.rows))[0] || null;
    }
  }
  if (!chunk) {
    chunk = {
      rows: [{ id: 'example', num: 1, cells: emptyCells(), lat: 41.4034, lon: 2.1741, file: 'example.pdf', page: 1 }],
      pages: [{ file: 'example.pdf', page: 1, text: '(No PDF text available for a real preview — load PDFs and detect coordinates, or tick a PDF to send. The instructions are exactly what will be sent.)' }],
    };
  }
  const { system, user } = buildPrompt({
    rows: chunk.rows, pages: chunk.pages, cols: state.cols,
    extra: s.extra, verify: s.verify, fill: s.fill, genus: s.genus, species: s.species,
    flagDelete: s.flagDelete, notes: s.notes, notesSpec: s.notesSpec, allowPrev: allow, allowNext: allow,
  });
  $('#llm-preview-system').textContent = system;
  const MAX = 8000;
  $('#llm-preview-user').textContent =
    user.length > MAX ? `${user.slice(0, MAX)}\n…(truncated for preview — ${user.length - MAX} more characters)` : user;
  $('#llm-preview-dialog').showModal();
}

$('#btn-llm').addEventListener('click', () => {
  // While a run is going, reopening is just to monitor/stop it — keep its
  // live status rather than wiping it.
  if (!llmRunning) llmStatus('');
  renderLlmFileList();
  llmDialog.showModal();
});

$('#llm-run').addEventListener('click', async () => {
  if (llmRunning) {
    llmAbort = true;
    llmStatus('Stopping after the in-flight request(s)…');
    return;
  }
  const s = collectLlmSettings();
  if (!s.url) return llmStatus('Enter an endpoint URL.');
  if (!s.model) return llmStatus('Enter a model name.');
  if (!s.key && s.provider !== 'custom') return llmStatus('Enter your API key.');
  if (!s.verify && !s.fill && !s.genus && !s.species && !s.flagDelete && !s.notes) return llmStatus('Pick at least one task.');
  if (s.useSecondModel) {
    const why = s.retry && s.confirmDelete ? 'second model' : s.retry ? 'retry model' : 'delete-confirmation model';
    if (!s.retryUrl) return llmStatus(`Enter the ${why}’s endpoint URL (or turn its option off).`);
    if (!s.retryModel) return llmStatus(`Enter the ${why}’s name (or turn its option off).`);
    if (!s.retryKey && s.retryProvider !== 'custom') return llmStatus(`Enter the ${why}’s API key (or turn its option off).`);
  }
  if (s.autoDelete) {
    const sure = confirm(
      'Automatic deletion is enabled: rows the LLM flags as false positives will be ' +
      'deleted WITHOUT asking you, based on nothing but the model\'s judgement.\n\n' +
      'LLMs make mistakes — real coordinates can be lost. Continue?'
    );
    if (!sure) return llmStatus('Cancelled — automatic deletion not confirmed.');
  }
  if (s.confirmDelete) {
    const sure = confirm(
      `Two-model deletion is enabled: model 1 flags suspected false positives, then the ` +
      `second model (${s.retryModel}) reviews each flag and any row it also rejects is DELETED ` +
      `without asking you per row.\n\n` +
      `This is safer than single-model auto-delete, but still risky — both models can be wrong ` +
      `the same way, and real coordinates can be lost. Rows the second model does not confirm ` +
      `keep their 🗑 flag for manual review. Continue?`
    );
    if (!sure) return llmStatus('Cancelled — two-model deletion not confirmed.');
  }
  if (s.files.size === 0) {
    return llmStatus(state.files.some((f) => !f.error)
      ? 'Select at least one PDF to send.'
      : 'No rows with a PDF source to process — scan some PDFs first. (Manually added rows are skipped.)');
  }
  const { work, skippedSent } = buildLlmWork(s);
  if (work.length === 0) {
    return llmStatus(skippedSent
      ? `Nothing to do — all ${skippedSent} row${skippedSent === 1 ? ' was' : 's were'} already sent to an LLM. Pick “All rows” to resend.`
      : 'No rows with a PDF source in the selected PDFs — scan some PDFs first. (Manually added rows are skipped.)');
  }

  llmRunning = true;
  llmAbort = false;
  $('#llm-run').textContent = 'Stop';
  const counts = {
    ok: 0, mismatch: 0, not_found: 0, filled: 0, noted: 0,
    flagged: 0, deleted: 0, unbadged: 0, retried: 0, retryFixed: 0,
    confirmChecked: 0, confirmKept: 0, deletedInfo: [], errors: [],
  };

  // The Notes column comes into existence the first time a notes run starts
  // (and then sticks around — it holds user data).
  if (s.notes && !state.notesOn) {
    state.notesOn = true;
    renderTable();
  }

  // Per-page batching and adjacent-page requests only apply when NOT sending
  // the whole PDF. Page flips let the model pull the page before/after a row to
  // finish the Genus/Species/Fill columns or anything the "Add to the prompt"
  // instructions ask.
  const perPage = s.perPage && s.scope !== 'all';
  const hasExtra = !!(s.extra && s.extra.trim());
  const wantsCols = s.fill || s.genus || s.species || hasExtra;
  const allowPrev = wantsCols && s.scope !== 'all';
  const allowNext = wantsCols && s.scope !== 'all';
  const MAX_PREV_PASSES = 3; // how far back a stubborn row may walk, one page per pass
  const MAX_NEXT_PASSES = 3; // how far forward a stubborn row may walk, one page per pass
  const MAX_BADGE_RETRIES = 2;

  // rowId -> context for retries and the deletion report.
  const meta = new Map();
  for (const w of work) {
    for (const r of w.rows) meta.set(r.id, { num: r.num, file: w.file.name, page: r.page, fileRec: w.file, llmRow: r });
  }
  const prevRows = new Set(); // rows that got a previous-page retry
  const nextRows = new Set(); // rows that got a next-page retry
  let stopped = false; // hard stop (auth failure)

  // Request config for the primary model, and the second model (used by the
  // "retry unfinished rows" and/or "confirm deletions" features).
  // When the advanced temperature toggle is off, `temp` is undefined and
  // buildRequest omits the field entirely (unchanged behaviour). Both models
  // share the one temperature setting.
  const temp = s.tempOn ? s.temperature : undefined;
  const primaryCfg = { kind: s.kind, url: s.url, model: s.model, key: s.key, temperature: temp };
  const secondCfg = s.useSecondModel ? { kind: s.retryKind, url: s.retryUrl, model: s.retryModel, key: s.retryKey, temperature: temp } : null;

  // Dispatch a list of requests. With a batch delay set, fire fixed-size batches
  // on a wall-clock cadence (runBatched); otherwise keep a steady pool in flight
  // (runPool). Both stop starting new work once Stop is pressed or a key fails.
  const shouldStop = () => llmAbort || stopped;
  const dispatch = (items, worker) =>
    s.batchDelay > 0
      ? runBatched(items, s.concurrency, s.batchDelay, worker, shouldStop)
      : runPool(items, s.concurrency, worker, shouldStop);
  // Parenthetical for the status line describing how requests are being paced.
  const pacingNote = () =>
    s.batchDelay > 0
      ? ` (${s.concurrency} per batch, a batch every ${s.batchDelay}ms)`
      : s.concurrency > 1 ? ` (${s.concurrency} at once)` : '';

  // A row counts as "processed by the LLM" only once it comes back badged (a
  // ✓/⚠/? verdict or 🗑 flag). Rows the model silently drops are re-sent below
  // until badged, and never marked sent, so a re-run picks them up too.
  const sentRowIds = new Set();
  const hasBadge = (id) => {
    const r = state.rows.find((rr) => rr.id === id);
    return !!(r && r.llm && (r.llm.verdict || r.llm.del));
  };

  // A row is "unfinished" when the model could not badge it, or left a task
  // column (Genus, Species, or a Fill column) empty. These are what the second
  // model is asked to retry.
  const isUnfinished = (id) => {
    const row = state.rows.find((r) => r.id === id);
    if (!row) return false;
    if (s.verify && !hasBadge(id)) return true;
    const cell = (i) => String((row.cells && row.cells[i]) || '').trim();
    if (s.genus && !cell(0)) return true;
    if (s.species && !cell(1)) return true;
    if (s.fill && state.cols.some((_, i) => !cell(i))) return true;
    return false;
  };

  // Send an already-built prompt to model `cfg`, parse the JSON row results.
  // Returns null (and records the problem) on an API error or empty parse.
  const postPrompt = async (system, user, label, cfg) => {
    const req = buildRequest({
      kind: cfg.kind, url: cfg.url, model: cfg.model, apiKey: cfg.key,
      system, user, temperature: cfg.temperature, browser: IS_WEB,
    });
    const res = await api.netFetch(req);
    if (res.error) throw new Error(res.error);
    if (!res.ok) {
      let detail = (res.text || '').slice(0, 300);
      try { extractText(cfg.kind, res.text); } catch (e) { detail = e.message; }
      counts.errors.push(`HTTP ${res.status}: ${detail}`);
      if (res.status === 401 || res.status === 403) stopped = true; // bad key: no point continuing
      return null;
    }
    const results = parseResultsJson(extractText(cfg.kind, res.text))
      .map((x) => normalizeResult(x, state.cols.length))
      .filter(Boolean);
    if (results.length === 0) {
      counts.errors.push(`${label}: the model returned no parseable JSON results.`);
      return null;
    }
    return results;
  };

  // One extraction request: build the full-task prompt, send, parse. `cfg`
  // chooses which model/endpoint/key to hit; the task instructions are the same.
  const sendChunk = (chunk, label, allowPrevHere, allowNextHere = false, cfg = primaryCfg) => {
    const { system, user } = buildPrompt({
      rows: chunk.rows, pages: chunk.pages, cols: state.cols,
      extra: s.extra, verify: s.verify, fill: s.fill, genus: s.genus, species: s.species,
      flagDelete: s.flagDelete, notes: s.notes, notesSpec: s.notesSpec,
      allowPrev: allowPrevHere, allowNext: allowNextHere,
    });
    return postPrompt(system, user, label, cfg);
  };

  // One delete-confirmation request: a flag-only prompt (no verify/fill/notes)
  // so the second model does nothing but judge whether each row is a false
  // positive. Used by the "delete only when a second model agrees" option.
  const sendConfirm = (chunk, label, cfg) => {
    const { system, user } = buildPrompt({
      rows: chunk.rows, pages: chunk.pages, cols: state.cols,
      extra: s.extra, verify: false, fill: false, genus: false, species: false,
      flagDelete: true, notes: false, allowPrev: false, allowNext: false,
    });
    return postPrompt(system, user, label, cfg);
  };

  const applyAndRender = (results) => {
    const deletedBefore = counts.deleted;
    applyLlmResults(results, s, counts, meta);
    if (counts.deleted > deletedBefore) renderAll();
    else renderTable();
  };

  // Run the full multi-pass extraction (initial requests, then previous/next
  // page walks, then badge retries) over `chunks` using model `cfg`. Rows sent
  // in this phase are returned; passes track their own page-flip requests.
  const runPasses = async ({ cfg, chunks, phase }) => {
    const tag = phase ? `${phase}: ` : '';
    const localSent = new Set();
    const needPrev = new Map(); // rowId -> earliest page to include on next prev pass
    const needNext = new Map(); // rowId -> latest page to include on next next pass

    // Initial requests. Each worker fetches, then applies its own results
    // synchronously — those applies can't interleave (single-threaded), so
    // counts/rows stay consistent.
    let done = 0;
    const total = chunks.length;
    await dispatch(chunks, async (chunk, n) => {
      const where = chunk.pages.length === 1 ? `${chunk.pages[0].file} p.${chunk.pages[0].page}` : chunk.pages[0].file;
      const results = await sendChunk(chunk, `${tag}Request ${n + 1}`, allowPrev, allowNext, cfg);
      done++;
      llmStatus(
        `${tag}${done}/${total} request${total === 1 ? '' : 's'} done` +
        `${pacingNote()} — ` +
        `${chunk.rows.length} row${chunk.rows.length === 1 ? '' : 's'} from ${where}…`
      );
      if (!results) return;
      for (const cr of chunk.rows) { localSent.add(cr.id); sentRowIds.add(cr.id); }
      applyAndRender(results);
      if (allowPrev) {
        for (const res of results) {
          const m = res.needPrev && meta.get(res.row);
          if (m && m.page > 1 && state.rows.some((r) => r.id === res.row)) needPrev.set(res.row, m.page - 1);
        }
      }
      if (allowNext) {
        for (const res of results) {
          const m = res.needNext && meta.get(res.row);
          if (m && m.page < m.fileRec.numPages && state.rows.some((r) => r.id === res.row)) needNext.set(res.row, m.page + 1);
        }
      }
    });

    // Previous-page passes: rows the model couldn't fill from their own page
    // are automatically resent with the preceding page(s) included, walking
    // back one more page per pass.
    for (let pass = 1; pass <= MAX_PREV_PASSES && needPrev.size && !llmAbort && !stopped; pass++) {
      const groups = new Map(); // same file + page window -> one request
      for (const [rowId, backTo] of needPrev) {
        const m = meta.get(rowId);
        if (!m) continue;
        const key = `${m.fileRec.id}:${m.page}:${backTo}`;
        if (!groups.has(key)) groups.set(key, { fileRec: m.fileRec, page: m.page, backTo, rows: [] });
        groups.get(key).rows.push(m.llmRow);
        prevRows.add(rowId);
      }
      needPrev.clear();
      const list = [...groups.values()];
      let d = 0;
      await dispatch(list, async (g) => {
        const pages = [];
        for (let num = g.backTo; num <= g.page; num++) {
          pages.push({ file: g.fileRec.name, page: num, text: await pageTextFor(g.fileRec, num) });
        }
        const canGoFurther = g.backTo > 1 && pass < MAX_PREV_PASSES;
        const results = await sendChunk({ pages, rows: g.rows }, `${tag}Previous-page pass ${pass}`, canGoFurther, false, cfg);
        d++;
        llmStatus(
          `${tag}Previous-page pass ${pass} — ${d}/${list.length} done: ` +
          `pages ${g.backTo}–${g.page} of ${g.fileRec.name} (${g.rows.length} row${g.rows.length === 1 ? '' : 's'})…`
        );
        if (!results) return;
        applyAndRender(results);
        if (canGoFurther) {
          for (const res of results) {
            if (res.needPrev && g.backTo - 1 >= 1 && state.rows.some((r) => r.id === res.row)) needPrev.set(res.row, g.backTo - 1);
          }
        }
      });
    }

    // Next-page passes: rows the model couldn't fill from their own page are
    // automatically resent with the following page(s) included, walking
    // forward one more page per pass (stopping at each file's last page).
    for (let pass = 1; pass <= MAX_NEXT_PASSES && needNext.size && !llmAbort && !stopped; pass++) {
      const groups = new Map(); // same file + page window -> one request
      for (const [rowId, forwardTo] of needNext) {
        const m = meta.get(rowId);
        if (!m) continue;
        const key = `${m.fileRec.id}:${m.page}:${forwardTo}`;
        if (!groups.has(key)) groups.set(key, { fileRec: m.fileRec, page: m.page, forwardTo, rows: [] });
        groups.get(key).rows.push(m.llmRow);
        nextRows.add(rowId);
      }
      needNext.clear();
      const list = [...groups.values()];
      let d = 0;
      await dispatch(list, async (g) => {
        const pages = [];
        for (let num = g.page; num <= g.forwardTo; num++) {
          pages.push({ file: g.fileRec.name, page: num, text: await pageTextFor(g.fileRec, num) });
        }
        const canGoFurther = g.forwardTo < g.fileRec.numPages && pass < MAX_NEXT_PASSES;
        const results = await sendChunk({ pages, rows: g.rows }, `${tag}Next-page pass ${pass}`, false, canGoFurther, cfg);
        d++;
        llmStatus(
          `${tag}Next-page pass ${pass} — ${d}/${list.length} done: ` +
          `pages ${g.page}–${g.forwardTo} of ${g.fileRec.name} (${g.rows.length} row${g.rows.length === 1 ? '' : 's'})…`
        );
        if (!results) return;
        applyAndRender(results);
        if (canGoFurther) {
          for (const res of results) {
            const m = meta.get(res.row);
            if (res.needNext && m && g.forwardTo + 1 <= m.fileRec.numPages && state.rows.some((r) => r.id === res.row)) {
              needNext.set(res.row, g.forwardTo + 1);
            }
          }
        }
      });
    }

    // Badge passes: every row sent in this phase should come back with a badge.
    // Rows the model dropped (no verdict, no flag) are re-sent — one focused
    // request per page — until they are badged or we run out of retries.
    for (let pass = 1; pass <= MAX_BADGE_RETRIES && !llmAbort && !stopped; pass++) {
      const pending = [...localSent].filter((id) => !hasBadge(id) && state.rows.some((r) => r.id === id));
      if (pending.length === 0) break;
      const groups = new Map(); // same file + page -> one request
      for (const id of pending) {
        const m = meta.get(id);
        if (!m) continue;
        const key = `${m.fileRec.id}:${m.page}`;
        if (!groups.has(key)) groups.set(key, { fileRec: m.fileRec, page: m.page, rows: [] });
        groups.get(key).rows.push(m.llmRow);
      }
      const list = [...groups.values()];
      let d = 0;
      await dispatch(list, async (g) => {
        const pages = [{ file: g.fileRec.name, page: g.page, text: await pageTextFor(g.fileRec, g.page) }];
        const results = await sendChunk({ pages, rows: g.rows }, `${tag}Badge retry ${pass}`, false, false, cfg);
        d++;
        llmStatus(
          `${tag}Badge retry ${pass}/${MAX_BADGE_RETRIES} — ${d}/${list.length} done: ` +
          `re-checking ${g.rows.length} row${g.rows.length === 1 ? '' : 's'} the model skipped on ${g.fileRec.name} p.${g.page}…`
        );
        if (!results) return;
        applyAndRender(results);
      });
    }
  };

  // Chunk a set of unfinished rows for the retry model, mirroring how the first
  // pass chunks its work (per-page vs. whole-PDF, coords-only vs. all pages).
  const buildRetryChunks = async (rowIds) => {
    const byFile = new Map(); // fileRec -> llmRow[]
    for (const id of rowIds) {
      const m = meta.get(id);
      if (!m) continue;
      if (!byFile.has(m.fileRec)) byFile.set(m.fileRec, []);
      byFile.get(m.fileRec).push(m.llmRow);
    }
    const out = [];
    for (const [fileRec, rows] of byFile) {
      const pages = [];
      for (const p of fileRec.pages) {
        if (s.scope !== 'all' && p.dets.length === 0) continue;
        pages.push({ file: fileRec.name, page: p.num, text: await pageTextFor(fileRec, p.num) });
      }
      out.push(...(perPage ? chunkPerPage(pages, rows) : chunkWork(pages, rows)));
    }
    return out;
  };

  try {
    llmStatus('Extracting page text…');
    const chunks = [];
    for (const w of work) {
      const pages = [];
      for (const num of w.pageNums) {
        pages.push({ file: w.file.name, page: num, text: await pageTextFor(w.file, num) });
      }
      chunks.push(...(perPage ? chunkPerPage(pages, w.rows) : chunkWork(pages, w.rows)));
    }

    await runPasses({ cfg: primaryCfg, chunks, phase: '' });

    // Retry with a different model: rows the first model left unfinished are
    // re-sent to the second model, which runs the same multi-pass extraction.
    if (s.retry && secondCfg && !llmAbort && !stopped) {
      const unfinished = [...meta.keys()].filter(isUnfinished);
      counts.retried = unfinished.length;
      if (unfinished.length) {
        llmStatus(`Retrying ${unfinished.length} unfinished row${unfinished.length === 1 ? '' : 's'} with ${secondCfg.model}…`);
        const retryChunks = await buildRetryChunks(unfinished);
        await runPasses({ cfg: secondCfg, chunks: retryChunks, phase: `Retry (${secondCfg.model})` });
        counts.retryFixed = unfinished.filter((id) => !isUnfinished(id)).length;
      }
    }

    // Two-model deletion: model 1 only flagged (auto-delete was suppressed);
    // the second model now reviews each flagged row and any it also rejects is
    // deleted. Rows it does not confirm keep their flag for manual review.
    if (s.confirmDelete && secondCfg && !llmAbort && !stopped) {
      const flagged = [...meta.keys()].filter((id) => {
        const r = state.rows.find((x) => x.id === id);
        return r && r.llm && r.llm.del;
      });
      counts.confirmChecked = flagged.length;
      if (flagged.length) {
        llmStatus(`Second model (${secondCfg.model}) reviewing ${flagged.length} flagged row${flagged.length === 1 ? '' : 's'} before deletion…`);
        const confirmChunks = await buildRetryChunks(flagged);
        let cdone = 0;
        await dispatch(confirmChunks, async (chunk, n) => {
          const results = await sendConfirm(chunk, `Delete-confirm ${n + 1}`, secondCfg);
          cdone++;
          llmStatus(`Delete confirmation — ${cdone}/${confirmChunks.length} request${confirmChunks.length === 1 ? '' : 's'} done…`);
          if (!results) return;
          const del = new Set();
          for (const res of results) {
            const row = state.rows.find((r) => r.id === res.row);
            if (!row || !(row.llm && row.llm.del)) continue; // only model-1 flags
            if (res.del === true) {
              del.add(row.id);
              counts.deleted++;
              const m = meta.get(row.id);
              counts.deletedInfo.push(
                `#${m ? m.num : '?'} — ${row.lat ?? '(no lat)'}, ${row.lon ?? '(no lon)'}` +
                `${m ? ` (${m.file} p.${m.page})` : ''}: ${res.note || 'both models flagged it'}`
              );
            } else {
              counts.confirmKept++;
              row.llm = { ...row.llm, note: `Second model (${secondCfg.model}) did not confirm this flag — kept for manual review.` };
            }
          }
          if (del.size) { removeRows(del); renderAll(); } else renderTable();
        });
      }
    }

    counts.unbadged = [...sentRowIds].filter((id) => !hasBadge(id) && state.rows.some((r) => r.id === id)).length;
  } catch (err) {
    counts.errors.push(err && err.message ? err.message : String(err));
  }

  // A row only counts as "sent to an LLM" once it has a badge, so rows the model
  // never badged stay unsent and are picked up again by an "only unsent" re-run.
  const sentAt = Date.now();
  for (const id of sentRowIds) {
    if (!hasBadge(id)) continue;
    const row = state.rows.find((r) => r.id === id);
    if (row) row.llmSent = sentAt;
  }

  llmRunning = false;
  $('#llm-run').textContent = 'Run';
  const parts = [];
  if (s.verify) parts.push(`verified ${counts.ok} ✓ · ${counts.mismatch} ⚠ mismatch · ${counts.not_found} ? not found`);
  if (s.fill || s.genus || s.species) parts.push(`${counts.filled} cell${counts.filled === 1 ? '' : 's'} filled`);
  if (s.notes) parts.push(`${counts.noted} note${counts.noted === 1 ? '' : 's'} written`);
  if (prevRows.size) parts.push(`${prevRows.size} row${prevRows.size === 1 ? '' : 's'} re-sent with earlier pages`);
  if (nextRows.size) parts.push(`${nextRows.size} row${nextRows.size === 1 ? '' : 's'} re-sent with later pages`);
  if (counts.retried) parts.push(`${counts.retried} unfinished row${counts.retried === 1 ? '' : 's'} retried with ${s.retryModel}${counts.retryFixed ? ` (${counts.retryFixed} resolved)` : ''}`);
  if (counts.unbadged) parts.push(`${counts.unbadged} row${counts.unbadged === 1 ? '' : 's'} still un-badged (run again to retry)`);
  if (s.unsentOnly && skippedSent) parts.push(`${skippedSent} already-sent row${skippedSent === 1 ? '' : 's'} skipped`);
  if (s.flagDelete) {
    if (s.autoDelete) {
      parts.push(`${counts.deleted} row${counts.deleted === 1 ? '' : 's'} auto-deleted`);
    } else if (s.confirmDelete) {
      parts.push(
        `${counts.flagged} row${counts.flagged === 1 ? '' : 's'} flagged by model 1; ` +
        `${counts.deleted} deleted after ${s.retryModel} agreed` +
        (counts.confirmKept ? `, ${counts.confirmKept} kept where it disagreed` : '') +
        (counts.flagged - counts.deleted - counts.confirmKept > 0
          ? `, ${counts.flagged - counts.deleted - counts.confirmKept} still flagged 🗑`
          : '')
      );
    } else {
      parts.push(`${counts.flagged} row${counts.flagged === 1 ? '' : 's'} flagged 🗑 (click a flag or "Delete Flagged" to remove)`);
    }
  }
  let msg = `${llmAbort ? 'Stopped early — ' : 'Done — '}${parts.join('; ')}.`;
  if (counts.deletedInfo.length) {
    msg += `\nDeleted rows (row numbers as sent to the LLM):\n• ${counts.deletedInfo.slice(0, 15).join('\n• ')}`;
    if (counts.deletedInfo.length > 15) msg += `\n…and ${counts.deletedInfo.length - 15} more`;
  }
  if (counts.errors.length) msg += `\nProblems:\n• ${counts.errors.slice(0, 5).join('\n• ')}`;
  msg += '\n⚠️ LLM output is not ground truth — verify it against the PDFs yourself.';
  llmStatus(msg);
  renderLlmFileList(); // sent counts changed
  refreshCounts();
  persistSoon();
});

// ---------------------------------------------------------------------------
// Projects & persistence: every project keeps its own files/rows/settings in
// IndexedDB and the whole session is restored on the next launch.
// ---------------------------------------------------------------------------

let persistTimer = null;

function persistSoon() {
  if (!project) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 600);
}

async function persistNow() {
  clearTimeout(persistTimer);
  persistTimer = null;
  if (!project) return;
  try {
    await storage.saveSnapshot(project.id, packState(state, nextId));
    project.updatedAt = Date.now();
    await storage.saveProjects(projects);
  } catch (err) {
    console.warn('CoordRippr: session save failed', err);
  }
}

// Best-effort flush when the window goes away mid-debounce.
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && persistTimer) persistNow();
});
window.addEventListener('beforeunload', () => {
  if (persistTimer) persistNow();
});

function makeProject(name) {
  const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return { id, name, createdAt: Date.now(), updatedAt: Date.now() };
}

function renderProjectSelect() {
  const sel = $('#project-select');
  sel.innerHTML = projects
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
    .join('');
  if (project) sel.value = project.id;
}

async function destroyDocs() {
  for (const f of state.files) {
    try { await f.doc?.destroy?.(); } catch { /* already gone */ }
  }
}

function resetState() {
  state.files = [];
  state.dets = new Map();
  state.rows = [];
  state.cols = ['Genus', 'Species'];
  state.notesOn = false;
  state.fmt = 'dd';
  state.showAll = false;
  state.showHighlights = true;
  state.zoom = 1.4;
  state.intensity = DEFAULT_INTENSITY;
  state.currentFile = null;
  state.suppressed = new Set();
  state.selected = new Set();
  state.anchor = null;
  state.activeRow = null;
  state.busy = false;
}

// Push state values back into the toolbar controls.
function syncControls() {
  for (const radio of document.querySelectorAll('input[name="fmt"]')) {
    radio.checked = radio.value === state.fmt;
  }
  $('#chk-all-pages').checked = state.showAll;
  $('#chk-highlights').checked = state.showHighlights;
  pagesEl.classList.toggle('no-hl', !state.showHighlights);
  $('#zoom-level').textContent = `${Math.round(state.zoom * 100)}%`;
  syncIntensityUi();
}

// Reattach a pdf.js document to a restored file: re-read from its path
// (Electron), else the bytes stored at load time (web, drag & drop). Only page
// rendering needs the document; rows and highlights survive either way.
async function reattachFile(file) {
  if (file.error) return;
  try {
    let data = null;
    if (file.path) {
      try { data = await api.readFile(file.path); } catch { /* moved/deleted */ }
    }
    if (!data) {
      const stored = await storage.loadPdf(project.id, file.id);
      if (stored && stored.bytes) data = stored.bytes;
    }
    if (!data) throw new Error('source PDF unavailable — open it again to see pages');
    file.doc = await pdfjsLib.getDocument({ data, ...PDF_OPEN_OPTS }).promise;
    file.numPages = file.doc.numPages;
    for (const pageRec of file.pages) {
      pageRec.proxy = await file.doc.getPage(pageRec.num);
    }
  } catch (err) {
    file.error = err && err.message ? err.message : String(err);
  }
}

async function restoreProject(id) {
  let data = null;
  try {
    data = unpackState(await storage.loadSnapshot(id));
  } catch { /* fresh project */ }
  await destroyDocs();
  resetState();
  if (data) {
    state.files = data.files;
    state.dets = data.dets;
    state.rows = data.rows;
    state.cols = data.cols;
    state.notesOn = data.notesOn;
    state.fmt = data.fmt;
    state.showAll = data.showAll;
    state.showHighlights = data.showHighlights;
    state.zoom = data.zoom;
    state.intensity = data.intensity;
    state.currentFile = data.currentFile;
    state.suppressed = data.suppressed;
    nextId = Math.max(nextId, data.nextId);
    if (state.files.length) {
      state.busy = true;
      setStatus('Restoring PDFs…', true);
      for (const file of state.files) await reattachFile(file);
      state.busy = false;
    }
  }
  syncControls();
  renderAll();
}

async function switchProject(id) {
  if (!project || id === project.id) return;
  if (state.busy) {
    $('#project-select').value = project.id;
    setStatus('Busy — wait for scanning to finish before switching projects.');
    return;
  }
  await persistNow();
  const target = projects.find((p) => p.id === id);
  if (!target) { renderProjectSelect(); return; }
  project = target;
  renderProjectSelect();
  try { await storage.setActiveProject(project.id); } catch { /* non-fatal */ }
  await restoreProject(project.id);
  setStatus(`Switched to “${project.name}” — ${state.rows.length} row${state.rows.length === 1 ? '' : 's'}.`);
}

// Small name-input dialog (Electron has no window.prompt).
function askName(title, initial = '') {
  return new Promise((resolve) => {
    const dlg = $('#name-dialog');
    $('#name-dialog-title').textContent = title;
    const input = $('#name-input');
    input.value = initial;
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'ok' ? input.value.trim() : null);
    };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    input.select();
  });
}

$('#project-select').addEventListener('change', (e) => switchProject(e.target.value));

$('#btn-proj-new').addEventListener('click', async () => {
  if (!project) return setStatus('Persistence is unavailable — projects are disabled.');
  if (state.busy) return setStatus('Busy — wait for scanning to finish.');
  const name = await askName('New project', `Project ${projects.length + 1}`);
  if (!name) return;
  await persistNow();
  const p = makeProject(name);
  projects.push(p);
  project = p;
  try {
    await storage.saveProjects(projects);
    await storage.setActiveProject(p.id);
  } catch { /* non-fatal */ }
  renderProjectSelect();
  await destroyDocs();
  resetState();
  syncControls();
  renderAll();
  setStatus(`Created project “${name}”. Open a folder of PDFs to begin.`);
});

$('#btn-proj-rename').addEventListener('click', async () => {
  if (!project) return;
  const name = await askName('Rename project', project.name);
  if (!name || name === project.name) return;
  project.name = name;
  project.updatedAt = Date.now();
  try { await storage.saveProjects(projects); } catch { /* non-fatal */ }
  renderProjectSelect();
  setStatus(`Renamed project to “${name}”.`);
});

$('#btn-proj-del').addEventListener('click', async () => {
  if (!project) return;
  if (state.busy) return setStatus('Busy — wait for scanning to finish.');
  const ok = confirm(
    `Delete project “${project.name}” and its saved session?\n\n` +
    `Your PDFs on disk are not touched, but the extracted rows and edits in ` +
    `this project are gone for good.`
  );
  if (!ok) return;
  const deadId = project.id;
  projects = projects.filter((p) => p.id !== deadId);
  try { await storage.deleteProject(deadId); } catch { /* non-fatal */ }
  if (projects.length === 0) projects = [makeProject('Project 1')];
  project = projects[0];
  try {
    await storage.saveProjects(projects);
    await storage.setActiveProject(project.id);
  } catch { /* non-fatal */ }
  renderProjectSelect();
  await restoreProject(project.id);
  setStatus(`Deleted project. Now in “${project.name}”.`);
});

async function initProjects() {
  try {
    projects = await storage.listProjects();
    if (projects.length === 0) {
      project = makeProject('Project 1');
      projects = [project];
      await storage.saveProjects(projects);
      await storage.setActiveProject(project.id);
    } else {
      const activeId = await storage.getActiveProject();
      project = projects.find((p) => p.id === activeId) || projects[0];
    }
    renderProjectSelect();
    await restoreProject(project.id);
    setStatus(state.rows.length
      ? `Resumed “${project.name}” — ${state.files.length} PDF${state.files.length === 1 ? '' : 's'} · ${state.rows.length} row${state.rows.length === 1 ? '' : 's'}.`
      : 'Ready. Open a folder of PDFs to begin.');
  } catch (err) {
    // IndexedDB unavailable (private mode, storage denied…): still usable,
    // just without projects/resume.
    console.warn('CoordRippr: persistence unavailable', err);
    project = null;
    projects = [];
    setStatus('Ready (persistence unavailable — this session will not be saved).');
  }
}

// ---------------------------------------------------------------------------
// Ko-fi, version display & release checking
// ---------------------------------------------------------------------------

$('#btn-kofi').addEventListener('click', () => api.openExternal(KOFI_URL));

const UPDATE_TS_KEY = 'coordrippr.lastUpdateCheck';
let appVersion = null;

async function checkForUpdates(manual) {
  if (!appVersion) return;
  if (manual) setStatus('Checking for updates…');
  localStorage.setItem(UPDATE_TS_KEY, String(Date.now()));
  const res = await api.netFetch({
    url: RELEASES_API,
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!res.ok) {
    if (manual) {
      setStatus(res.status === 404
        ? 'No releases have been published yet.'
        : `Update check failed (${res.error || `HTTP ${res.status}`}).`);
    }
    return;
  }
  let tag = null;
  let url = RELEASES_PAGE;
  try {
    const data = JSON.parse(res.text);
    tag = data.tag_name;
    if (data.html_url) url = data.html_url;
  } catch { /* malformed response — treat as no update */ }
  if (tag && isNewer(tag, appVersion)) {
    const chip = $('#update-chip');
    chip.textContent = `⬆ ${tag} available`;
    chip.classList.remove('hidden');
    chip.onclick = () => api.openExternal(url);
    if (manual) setStatus(`Update available: ${tag} — click the green chip to download.`);
  } else if (manual) {
    setStatus(`CoordRippr v${appVersion} is up to date.`);
  }
}

$('#btn-check-updates').addEventListener('click', () => checkForUpdates(true));

async function initVersionAndUpdates() {
  try { appVersion = await api.getVersion(); } catch { appVersion = null; }
  if (!appVersion) {
    // Web build: nothing to update.
    $('#btn-check-updates').classList.add('hidden');
    $('#app-version').textContent = 'web';
    return;
  }
  $('#app-version').textContent = `v${appVersion}`;
  // Daily check: once on startup if due, then re-tested hourly.
  if (isDue(localStorage.getItem(UPDATE_TS_KEY))) checkForUpdates(false);
  setInterval(() => {
    if (isDue(localStorage.getItem(UPDATE_TS_KEY))) checkForUpdates(false);
  }, 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

initLlmDialog();
initVersionAndUpdates();
renderTable();
syncControls();
setStatus('Loading…');
const appReady = initProjects();

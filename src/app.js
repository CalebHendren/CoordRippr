// CoordRippr renderer: batch-scans PDFs for coordinates, shows highlighted
// pages on the right, editable CSV preview on the left, with two-way jumping.

import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.min.mjs';
import { extractCoordinates, parseSingle, formatDD, formatDMS } from './coords.js';
import { buildPageText, rectsForRange } from './pdftext.js';

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
  dets: new Map(), // detId -> {id, fileId, pageNum, rects, rowId, half, raw}
  rows: [], // {id, c1, c2, lat, lon, latRaw, lonRaw, src:{fileId,pageNum,latDet,lonDet}}
  headers: { c1: 'Field 1', c2: 'Field 2' },
  fmt: 'dd', // 'dd' | 'dms' | 'both'
  showAll: false,
  zoom: 1.4,
  currentFile: null,
  selected: new Set(),
  anchor: null,
  activeRow: null,
  busy: false,
};

let nextId = 1;
const uid = (p) => `${p}${nextId++}`;

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
    };
    state.files.push(file);
    try {
      setStatus(`Scanning ${spec.name} (${done}/${specs.length})…`, true);
      const data = spec.data || (await window.coordrippr.readFile(spec.path));
      file.doc = await pdfjsLib.getDocument({ data, ...PDF_OPEN_OPTS }).promise;
      file.numPages = file.doc.numPages;
      for (let p = 1; p <= file.numPages; p++) {
        const page = await file.doc.getPage(p);
        const vp = page.getViewport({ scale: 1 });
        const pageRec = { num: p, w: vp.width, h: vp.height, proxy: page, dets: [] };
        const tc = await page.getTextContent();
        const { text, spans } = buildPageText(tc);
        for (const pair of extractCoordinates(text)) {
          addDetectedRow(file, pageRec, pair, spans);
        }
        file.pages.push(pageRec);
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
  renderFileList();
  renderPages();
  renderTable();
  refreshCounts();
}

function addDetectedRow(file, pageRec, pair, spans) {
  const row = {
    id: uid('r'), c1: '', c2: '',
    lat: pair.lat ? pair.lat.dd : null,
    lon: pair.lon ? pair.lon.dd : null,
    latRaw: null, lonRaw: null,
    src: { fileId: file.id, pageNum: pageRec.num, latDet: null, lonDet: null },
  };
  for (const half of ['lat', 'lon']) {
    const tok = pair[half];
    if (!tok) continue;
    const det = {
      id: uid('d'), fileId: file.id, pageNum: pageRec.num,
      rects: rectsForRange(spans, tok.start, tok.end),
      rowId: row.id, half, raw: tok.raw,
    };
    state.dets.set(det.id, det);
    pageRec.dets.push(det.id);
    row.src[half + 'Det'] = det.id;
  }
  state.rows.push(row);
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
    el.className = 'file-entry' + (f.id === state.currentFile ? ' current' : '');
    const meta = f.error
      ? `<span class="err">error: ${escapeHtml(f.error)}</span>`
      : `<span class="${nDet ? 'count' : 'zero'}">${nDet} coord${nDet === 1 ? '' : 's'}</span> · ${f.numPages} p.`;
    el.innerHTML = `<div class="fname">${escapeHtml(f.name)}</div><div class="fmeta">${meta}</div>`;
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
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
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

function renderTable() {
  const cols = coordColumns();

  // Header
  theadEl.innerHTML = '';
  const hr = document.createElement('tr');
  hr.innerHTML =
    `<th class="rownum">#</th>` +
    `<th><input data-h="c1" value="${escapeHtml(state.headers.c1)}" title="Column 1 header (editable)"/></th>` +
    `<th><input data-h="c2" value="${escapeHtml(state.headers.c2)}" title="Column 2 header (editable)"/></th>` +
    cols.map((c) => `<th>${c.label}</th>`).join('') +
    `<th class="srcinfo" title="Where the coordinate was found (not exported)">source</th>`;
  theadEl.appendChild(hr);

  // Body
  tbodyEl.innerHTML = '';
  for (const row of state.rows) {
    tbodyEl.appendChild(buildRowEl(row, cols));
  }
  $('#csv-empty').style.display = state.rows.length ? 'none' : '';
  refreshRowClasses();
}

function buildRowEl(row, cols) {
  const tr = document.createElement('tr');
  tr.dataset.row = row.id;

  const idx = state.rows.indexOf(row);
  const tdNum = document.createElement('td');
  tdNum.className = 'rownum';
  tdNum.textContent = idx + 1;
  tr.appendChild(tdNum);

  for (const field of ['c1', 'c2']) {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.value = row[field];
    input.dataset.field = field;
    td.appendChild(input);
    tr.appendChild(td);
  }

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
  if (row.src) {
    const f = state.files.find((x) => x.id === row.src.fileId);
    tdSrc.textContent = `${f ? f.name : '?'} p.${row.src.pageNum}`;
    tdSrc.title = 'Click to show in PDF';
  } else {
    tdSrc.textContent = '—';
  }
  tr.appendChild(tdSrc);
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
  if (h) state.headers[h] = e.target.value;
});

tbodyEl.addEventListener('change', (e) => {
  const input = e.target;
  const tr = input.closest('tr');
  const row = state.rows.find((r) => r.id === tr?.dataset.row);
  if (!row) return;
  const field = input.dataset.field;

  if (field === 'c1' || field === 'c2') {
    row[field] = input.value;
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
});

// Click a row -> make it active and jump to its PDF spot.
tbodyEl.addEventListener('click', (e) => {
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
// Toolbar / tools
// ---------------------------------------------------------------------------

$('#btn-open-folder').addEventListener('click', async () => {
  const res = await window.coordrippr.chooseFolder();
  if (!res) return;
  if (res.files.length === 0) { setStatus('No PDFs found in that folder.'); return; }
  await loadFiles(res.files.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() })));
});

$('#btn-open-files').addEventListener('click', async () => {
  const res = await window.coordrippr.choosePdfs();
  if (!res) return;
  await loadFiles(res.files.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() })));
});

for (const radio of document.querySelectorAll('input[name="fmt"]')) {
  radio.addEventListener('change', () => {
    state.fmt = radio.value;
    renderTable();
  });
}

$('#chk-all-pages').addEventListener('change', (e) => {
  state.showAll = e.target.checked;
  renderPages();
});

$('#btn-zoom-in').addEventListener('click', () => setZoom(state.zoom + 0.2));
$('#btn-zoom-out').addEventListener('click', () => setZoom(state.zoom - 0.2));

function setZoom(z) {
  state.zoom = Math.min(3, Math.max(0.6, Math.round(z * 10) / 10));
  $('#zoom-level').textContent = `${Math.round(state.zoom * 100)}%`;
  renderPages();
}

$('#btn-add-row').addEventListener('click', () => {
  state.rows.push({
    id: uid('r'), c1: '', c2: '', lat: null, lon: null,
    latRaw: null, lonRaw: null, src: null,
  });
  renderTable();
  refreshCounts();
  tbodyEl.lastElementChild?.scrollIntoView({ block: 'nearest' });
});

$('#btn-del-rows').addEventListener('click', () => {
  if (state.selected.size === 0) { setStatus('Select rows first (click the row numbers).'); return; }
  for (const row of state.rows) {
    if (!state.selected.has(row.id) || !row.src) continue;
    for (const detId of [row.src.latDet, row.src.lonDet]) {
      if (!detId) continue;
      const det = state.dets.get(detId);
      if (det) {
        const file = state.files.find((f) => f.id === det.fileId);
        const pageRec = file?.pages.find((p) => p.num === det.pageNum);
        if (pageRec) pageRec.dets = pageRec.dets.filter((d) => d !== detId);
      }
      state.dets.delete(detId);
    }
  }
  state.rows = state.rows.filter((r) => !state.selected.has(r.id));
  state.selected.clear();
  state.anchor = null;
  if (!state.rows.some((r) => r.id === state.activeRow)) state.activeRow = null;
  renderTable();
  renderFileList();
  renderPages();
  refreshCounts();
});

function applyFill(rowIds, colField, value) {
  let n = 0;
  for (const row of state.rows) {
    if (rowIds.has(row.id)) { row[colField] = value; n++; }
  }
  renderTable();
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
  const header = [state.headers.c1, state.headers.c2, ...cols.map((c) => c.label)];
  const lines = [header.map(csvEscape).join(',')];
  for (const row of state.rows) {
    const cells = [row.c1, row.c2, ...cols.map((c) => cellText(row, c))];
    lines.push(cells.map(csvEscape).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

$('#btn-export').addEventListener('click', async () => {
  if (state.rows.length === 0) { setStatus('Nothing to export yet.'); return; }
  const saved = await window.coordrippr.saveCsv({
    defaultName: 'coordinates.csv',
    content: buildCsv(),
  });
  setStatus(saved ? `Saved ${saved}` : 'Export cancelled.');
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

window.coordrippr.onAutoload((paths) => {
  loadFiles(paths.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() })));
});

renderTable();
setZoom(state.zoom);
setStatus('Ready. Open a folder of PDFs to begin.');

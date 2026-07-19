// CoordRippr persistence: projects + session snapshots + PDF bytes in IndexedDB,
// so Electron and browser builds resume where the user left off.
// packState/unpackState are pure (node --test); `storage` is the IndexedDB glue.

export const SNAPSHOT_VERSION = 2;

// ---------------------------------------------------------------------------
// Pure snapshot packing / unpacking
// ---------------------------------------------------------------------------

/**
 * Live state -> plain JSON-able snapshot. Page proxies and pdf.js docs are
 * dropped; restore reattaches them from stored PDF bytes (or disk in Electron).
 */
export function packState(state, nextId) {
  return {
    v: SNAPSHOT_VERSION,
    savedAt: Date.now(),
    nextId,
    cols: [...state.cols],
    notesOn: !!state.notesOn,
    fmt: state.fmt,
    showAll: !!state.showAll,
    showHighlights: state.showHighlights !== false,
    zoom: state.zoom,
    intensity: state.intensity,
    currentFile: state.currentFile,
    suppressed: [...(state.suppressed || [])],
    files: state.files.map((f) => ({
      id: f.id,
      name: f.name,
      path: f.path || null,
      error: f.error || null,
      numPages: f.numPages,
      intensity: typeof f.intensity === 'number' ? f.intensity : null, // per-PDF net override
      hidden: !!f.hidden, // user set this PDF aside (excluded from view/CSV, kept for un-hiding)
      pages: f.pages.map((p) => ({ num: p.num, w: p.w, h: p.h, dets: [...p.dets] })),
    })),
    dets: [...state.dets.values()].map((d) => ({
      id: d.id, fileId: d.fileId, pageNum: d.pageNum,
      rects: d.rects, rowId: d.rowId, half: d.half, raw: d.raw,
      span: d.span || null,
    })),
    rows: state.rows.map((r) => ({
      id: r.id, cells: [...(r.cells || [])], notes: r.notes || '',
      lat: r.lat, lon: r.lon, latRaw: r.latRaw, lonRaw: r.lonRaw,
      src: r.src ? { ...r.src } : null,
      llm: r.llm ? { ...r.llm } : undefined,
      llmSent: r.llmSent || undefined,
    })),
  };
}

/**
 * Snapshot -> state fields. null when the snapshot is unusable. Files come back
 * without `doc`/page proxies; the caller re-opens the PDFs and reattaches them.
 */
export function unpackState(snap) {
  if (!snap || typeof snap !== 'object' || !Array.isArray(snap.files)) return null;
  const dets = new Map();
  for (const d of snap.dets || []) {
    if (d && d.id) dets.set(d.id, { ...d, rects: d.rects || [] });
  }
  const files = snap.files.map((f) => ({
    id: f.id,
    name: f.name,
    path: f.path || null,
    doc: null,
    error: f.error || null,
    numPages: f.numPages || 0,
    intensity: typeof f.intensity === 'number' ? f.intensity : null, // per-PDF net override
    hidden: !!f.hidden, // set-aside PDFs stay set aside across reloads
    pages: (f.pages || []).map((p) => ({
      num: p.num, w: p.w, h: p.h, proxy: null, dets: [...(p.dets || [])],
    })),
  }));
  const cols = Array.isArray(snap.cols) && snap.cols.length
    ? snap.cols.map((c) => String(c ?? ''))
    : ['Genus', 'Species'];
  const rows = (snap.rows || []).map((r) => {
    const cells = Array.isArray(r.cells) ? r.cells.map((c) => String(c ?? '')) : [];
    while (cells.length < cols.length) cells.push('');
    return {
      id: r.id, cells: cells.slice(0, cols.length), notes: r.notes || '',
      lat: r.lat ?? null, lon: r.lon ?? null,
      latRaw: r.latRaw ?? null, lonRaw: r.lonRaw ?? null,
      src: r.src || null,
      ...(r.llm ? { llm: r.llm } : {}),
      ...(r.llmSent ? { llmSent: r.llmSent } : {}),
    };
  });
  return {
    nextId: Number(snap.nextId) || 1,
    cols,
    notesOn: !!snap.notesOn,
    fmt: snap.fmt || 'dd',
    showAll: !!snap.showAll,
    showHighlights: snap.showHighlights !== false, // default on when the field is absent
    zoom: typeof snap.zoom === 'number' ? snap.zoom : 1.4,
    intensity: typeof snap.intensity === 'number' ? snap.intensity : 5, // Balanced (DEFAULT_INTENSITY)
    currentFile: snap.currentFile ?? null,
    suppressed: new Set(Array.isArray(snap.suppressed) ? snap.suppressed : []),
    files,
    dets,
    rows,
  };
}

// ---------------------------------------------------------------------------
// IndexedDB glue
// ---------------------------------------------------------------------------

const DB_NAME = 'coordrippr';
const DB_VERSION = 1;
const META = 'meta'; // 'projects' -> [{id,name,createdAt,updatedAt}], 'activeProject' -> id
const SNAPSHOTS = 'snapshots'; // projectId -> snapshot
const PDFS = 'pdfs'; // `${projectId}:${fileId}` -> {name, bytes}

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const store of [META, SNAPSHOTS, PDFS]) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(db, store, mode, run) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = run(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
  });
}

async function idbGet(store, key) {
  const db = await openDb();
  return tx(db, store, 'readonly', (s) => s.get(key));
}

async function idbPut(store, key, value) {
  const db = await openDb();
  await tx(db, store, 'readwrite', (s) => s.put(value, key));
}

async function idbDelete(store, keyOrRange) {
  const db = await openDb();
  await tx(db, store, 'readwrite', (s) => s.delete(keyOrRange));
}

const pdfKey = (projectId, fileId) => `${projectId}:${fileId}`;
const pdfRange = (projectId) => IDBKeyRange.bound(`${projectId}:`, `${projectId}:\uffff`);

export const storage = {
  async listProjects() {
    return (await idbGet(META, 'projects')) || [];
  },
  async saveProjects(list) {
    await idbPut(META, 'projects', list);
  },
  async getActiveProject() {
    return (await idbGet(META, 'activeProject')) ?? null;
  },
  async setActiveProject(id) {
    await idbPut(META, 'activeProject', id);
  },
  async loadSnapshot(projectId) {
    return (await idbGet(SNAPSHOTS, projectId)) ?? null;
  },
  async saveSnapshot(projectId, snapshot) {
    await idbPut(SNAPSHOTS, projectId, snapshot);
  },
  async savePdf(projectId, fileId, name, bytes) {
    await idbPut(PDFS, pdfKey(projectId, fileId), { name, bytes });
  },
  async loadPdf(projectId, fileId) {
    return (await idbGet(PDFS, pdfKey(projectId, fileId))) ?? null;
  },
  async deleteProject(projectId) {
    await idbDelete(SNAPSHOTS, projectId);
    await idbDelete(PDFS, pdfRange(projectId));
  },
};

// CoordRippr persistence: projects + session snapshots + PDF bytes, stored in
// IndexedDB so both the Electron build and the browser build resume exactly
// where the user left off. packState/unpackState are pure (node --test
// covers them); the storage object is the IndexedDB glue and only touches
// indexedDB when called.

export const SNAPSHOT_VERSION = 1;

// ---------------------------------------------------------------------------
// Pure snapshot packing / unpacking
// ---------------------------------------------------------------------------

/**
 * Turn the renderer's live state into a plain JSON-able snapshot. Page
 * proxies and pdf.js documents are dropped — they are reattached on restore
 * from the stored PDF bytes (or re-read from disk in Electron).
 */
export function packState(state, nextId) {
  return {
    v: SNAPSHOT_VERSION,
    savedAt: Date.now(),
    nextId,
    headers: { ...state.headers },
    fmt: state.fmt,
    showAll: !!state.showAll,
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
      pages: f.pages.map((p) => ({ num: p.num, w: p.w, h: p.h, dets: [...p.dets] })),
    })),
    dets: [...state.dets.values()].map((d) => ({
      id: d.id, fileId: d.fileId, pageNum: d.pageNum,
      rects: d.rects, rowId: d.rowId, half: d.half, raw: d.raw,
      span: d.span || null,
    })),
    rows: state.rows.map((r) => ({
      id: r.id, c1: r.c1, c2: r.c2,
      lat: r.lat, lon: r.lon, latRaw: r.latRaw, lonRaw: r.lonRaw,
      src: r.src ? { ...r.src } : null,
      llm: r.llm ? { ...r.llm } : undefined,
    })),
  };
}

/**
 * Rebuild state fields from a snapshot. Returns null for anything that is
 * not a usable snapshot. Files come back without `doc`/page proxies; the
 * caller re-opens the PDFs and reattaches them.
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
    pages: (f.pages || []).map((p) => ({
      num: p.num, w: p.w, h: p.h, proxy: null, dets: [...(p.dets || [])],
    })),
  }));
  const rows = (snap.rows || []).map((r) => ({
    id: r.id, c1: r.c1 || '', c2: r.c2 || '',
    lat: r.lat ?? null, lon: r.lon ?? null,
    latRaw: r.latRaw ?? null, lonRaw: r.lonRaw ?? null,
    src: r.src || null,
    ...(r.llm ? { llm: r.llm } : {}),
  }));
  return {
    nextId: Number(snap.nextId) || 1,
    headers: { c1: 'Field 1', c2: 'Field 2', ...(snap.headers || {}) },
    fmt: snap.fmt || 'dd',
    showAll: !!snap.showAll,
    zoom: typeof snap.zoom === 'number' ? snap.zoom : 1.4,
    intensity: typeof snap.intensity === 'number' ? snap.intensity : 3,
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

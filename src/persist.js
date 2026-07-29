// CoordRippr persistence: projects + session snapshots + PDF bytes, so Electron
// and browser builds resume where the user left off. packState/unpackState and
// migrateSnapshot are pure (node --test); below them sit two interchangeable
// back ends — plain files on disk (Electron) and IndexedDB (browser).

import { DEFAULT_INTENSITY, LEGACY_INTENSITY_MAP } from './coords.js';

// 3: the detection net went from 7 steps to 12 (see migrateSnapshot).
export const SNAPSHOT_VERSION = 3;

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
      // Drawn by hand over the page rather than found by the parser. Kept out of
      // re-scans and never suppressed (it has no text offset to key on).
      ...(d.manual ? { manual: true } : {}),
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
 * Bring an older snapshot up to SNAPSHOT_VERSION. Returns a new object; the
 * input is left alone. Unknown/newer versions pass through untouched.
 *
 * v2 -> v3: the detection net grew from 7 steps to 12. Every old level still
 * exists, just under a new number (LEGACY_INTENSITY_MAP), so a restored project
 * keeps scanning exactly as it did. A v2 snapshot that never stored an intensity
 * predates the per-project setting and was scanned at the old default,
 * Balanced — level 7 on the new scale, NOT the new default of 1.
 */
export function migrateSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return snap;
  const v = Number(snap.v) || 1;
  if (v >= 3) return snap;
  const remap = (level) => (typeof level === 'number' ? LEGACY_INTENSITY_MAP[level] ?? level : level);
  return {
    ...snap,
    v: SNAPSHOT_VERSION,
    intensity: typeof snap.intensity === 'number' ? remap(snap.intensity) : 7,
    // Leave a missing/!Array `files` exactly as it was: unpackState uses it to
    // decide the snapshot is unusable, and inventing an empty array here would
    // turn garbage into an apparently valid empty session.
    ...(Array.isArray(snap.files)
      ? { files: snap.files.map((f) => ({ ...f, intensity: remap(f && f.intensity) })) }
      : {}),
  };
}

/**
 * Snapshot -> state fields. null when the snapshot is unusable. Files come back
 * without `doc`/page proxies; the caller re-opens the PDFs and reattaches them.
 * Older snapshots are migrated on the way through.
 */
export function unpackState(rawSnap) {
  const snap = migrateSnapshot(rawSnap);
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
    intensity: typeof snap.intensity === 'number' ? snap.intensity : DEFAULT_INTENSITY,
    currentFile: snap.currentFile ?? null,
    suppressed: new Set(Array.isArray(snap.suppressed) ? snap.suppressed : []),
    files,
    dets,
    rows,
  };
}

// ---------------------------------------------------------------------------
// IndexedDB back end (browser build)
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

export const idbStorage = {
  kind: 'indexeddb',
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
  async getSettings() {
    return (await idbGet(META, 'settings')) || {};
  },
  async saveSettings(obj) {
    await idbPut(META, 'settings', obj);
  },
};

// ---------------------------------------------------------------------------
// File back end (Electron)
//
// Chromium keeps a file:// renderer's IndexedDB inside the browser profile, and
// that is what goes missing when the app is reinstalled over itself — projects
// vanish on update even though nothing deleted them. Plain JSON and PDF files in
// the app's data folder have no such lifecycle: they survive updates, they can
// be backed up or synced, and the user can point the folder somewhere else.
//
//   projects.json                    [{id,name,createdAt,updatedAt}]
//   active.json                      {"id": "p…"}
//   settings.json                    {theme, llm:{…}}
//   projects/<id>/snapshot.json
//   projects/<id>/pdfs/<fileId>.pdf
// ---------------------------------------------------------------------------

const projDir = (projectId) => `projects/${projectId}`;

function makeFileStorage(store) {
  const readJson = async (rel, fallback) => {
    try {
      const text = await store.read(rel);
      // These are plain files a user can open and edit; a Windows editor will
      // happily add a byte-order mark, which JSON.parse refuses. Stripping it
      // beats silently falling back and looking like the settings were lost.
      return text ? JSON.parse(text.replace(/^\uFEFF/, '')) : fallback;
    } catch {
      return fallback; // absent or corrupt: start clean rather than wedge the app
    }
  };
  const writeJson = (rel, value) => store.write(rel, JSON.stringify(value));

  return {
    kind: 'file',
    listProjects: () => readJson('projects.json', []),
    saveProjects: (list) => writeJson('projects.json', list),
    async getActiveProject() {
      return (await readJson('active.json', {})).id ?? null;
    },
    setActiveProject: (id) => writeJson('active.json', { id }),
    loadSnapshot: (projectId) => readJson(`${projDir(projectId)}/snapshot.json`, null),
    saveSnapshot: (projectId, snapshot) => writeJson(`${projDir(projectId)}/snapshot.json`, snapshot),
    async savePdf(projectId, fileId, name, bytes) {
      await store.writeBin(`${projDir(projectId)}/pdfs/${fileId}.pdf`, bytes);
      const names = await readJson(`${projDir(projectId)}/pdfs/names.json`, {});
      if (names[fileId] !== name) {
        names[fileId] = name;
        await writeJson(`${projDir(projectId)}/pdfs/names.json`, names);
      }
    },
    async loadPdf(projectId, fileId) {
      const bytes = await store.readBin(`${projDir(projectId)}/pdfs/${fileId}.pdf`);
      if (!bytes) return null;
      const names = await readJson(`${projDir(projectId)}/pdfs/names.json`, {});
      return { name: names[fileId] || `${fileId}.pdf`, bytes };
    },
    deleteProject: (projectId) => store.remove(projDir(projectId)),
    getSettings: () => readJson('settings.json', {}),
    saveSettings: (obj) => writeJson('settings.json', obj),
  };
}

// ---------------------------------------------------------------------------
// Back-end selection + settings
// ---------------------------------------------------------------------------

// `store` only exists in the Electron preload; the browser build keeps IndexedDB.
const nativeStore = typeof window !== 'undefined' && window.coordrippr && window.coordrippr.store;
export const storage = nativeStore ? makeFileStorage(nativeStore) : idbStorage;

/**
 * One-time lift of everything in IndexedDB into the file store, for users
 * upgrading from a build that only had IndexedDB. Nothing is deleted from
 * IndexedDB — if this goes wrong the old copy is still there.
 * No-op unless the file store is active and empty.
 * @returns {Promise<number>} how many projects were carried over
 */
export async function migrateIdbToFiles() {
  if (storage.kind !== 'file') return 0;
  const settings = await storage.getSettings();
  if (settings.migratedFromIdb) return 0;
  let moved = 0;
  try {
    if ((await storage.listProjects()).length === 0) {
      const projects = await idbStorage.listProjects();
      for (const p of projects) {
        const snap = await idbStorage.loadSnapshot(p.id);
        if (snap) await storage.saveSnapshot(p.id, snap);
        for (const f of (snap && snap.files) || []) {
          const pdf = await idbStorage.loadPdf(p.id, f.id).catch(() => null);
          if (pdf && pdf.bytes) await storage.savePdf(p.id, f.id, pdf.name || f.name, pdf.bytes);
        }
        moved++;
      }
      if (moved) {
        await storage.saveProjects(projects);
        const active = await idbStorage.getActiveProject();
        if (active) await storage.setActiveProject(active);
      }
    }
  } catch {
    // No IndexedDB (or it is unreadable): nothing to carry over.
  }
  await storage.saveSettings({ ...(await storage.getSettings()), migratedFromIdb: true });
  return moved;
}

/**
 * Read one key out of the app-wide settings blob (theme, LLM prefs, …). These
 * used to live in localStorage, which disappears with IndexedDB on reinstall —
 * `legacyKey` names the old localStorage entry so it is adopted once and then
 * follows the projects into the durable store.
 */
export async function getSetting(key, fallback = null, legacyKey = null) {
  let settings = {};
  try { settings = await storage.getSettings(); } catch { /* unavailable */ }
  if (settings[key] !== undefined) return settings[key];
  if (legacyKey) {
    try {
      const raw = localStorage.getItem(legacyKey);
      if (raw != null) {
        const value = JSON.parse(raw);
        await setSetting(key, value);
        return value;
      }
    } catch { /* absent or not JSON */ }
  }
  return fallback;
}

/** Write one key into the app-wide settings blob. Failures are non-fatal. */
export async function setSetting(key, value) {
  try {
    await storage.saveSettings({ ...(await storage.getSettings()), [key]: value });
  } catch (err) {
    console.warn('CoordRippr: could not save setting', key, err);
  }
}

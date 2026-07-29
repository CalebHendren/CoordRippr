// CoordRippr project export / import: one project (its snapshot, and optionally
// copies of its PDFs) as a single portable `.crproj` file. Pure module — no DOM,
// no Electron, no storage — so it is unit-tested directly; the caller supplies
// the PDF bytes and decides where the file goes.

export const PROJECT_FILE_VERSION = 1;
export const PROJECT_FILE_EXT = 'crproj';

// ---------------------------------------------------------------------------
// Base64 <-> bytes. PDFs have to survive a JSON round-trip, and the two runtimes
// disagree about how: Node has Buffer, browsers have atob/btoa. Chunked so a
// multi-megabyte PDF cannot blow the argument limit of String.fromCharCode.
// ---------------------------------------------------------------------------

const CHUNK = 0x8000;

/** ArrayBuffer | TypedArray -> base64 string. */
export function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof Buffer !== 'undefined') return Buffer.from(view).toString('base64');
  let binary = '';
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 string -> ArrayBuffer. */
export function base64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  const binary = atob(String(b64 || ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

// ---------------------------------------------------------------------------
// Pack / unpack
// ---------------------------------------------------------------------------

/**
 * Build the export bundle.
 *
 * @param {object}  p
 * @param {object}  p.project   {id, name, …} — only the name travels; the
 *                              importing side always mints a fresh id.
 * @param {object}  p.snapshot  packState() output
 * @param {Array}   [p.pdfs]    [{fileId, name, bytes}] — omit (or pass []) to
 *                              export rows and settings only. Without them the
 *                              import can still show every row and highlight;
 *                              page images come back only for PDFs whose stored
 *                              path still resolves on the importing machine.
 * @returns {object} JSON-able bundle
 */
export function packProjectFile({ project, snapshot, pdfs = [] }) {
  return {
    app: 'CoordRippr',
    v: PROJECT_FILE_VERSION,
    exportedAt: Date.now(),
    project: { name: (project && project.name) || 'Imported project' },
    snapshot,
    pdfs: pdfs.map((f) => ({
      fileId: f.fileId,
      name: f.name,
      b64: bytesToBase64(f.bytes),
    })),
  };
}

/**
 * Read a bundle back. Throws with a user-facing message when the file is not a
 * CoordRippr export or is too new to understand.
 *
 * @param {object|string} data  parsed bundle, or the raw file text
 * @returns {{name: string, snapshot: object, pdfs: Array<{fileId, name, bytes}>, exportedAt: number|null}}
 */
export function unpackProjectFile(data) {
  let bundle = data;
  if (typeof bundle === 'string') {
    try {
      bundle = JSON.parse(bundle);
    } catch {
      throw new Error('That file is not a CoordRippr project (it is not valid JSON).');
    }
  }
  if (!bundle || typeof bundle !== 'object' || bundle.app !== 'CoordRippr' || !bundle.snapshot) {
    throw new Error(`That file is not a CoordRippr project export (.${PROJECT_FILE_EXT}).`);
  }
  if (Number(bundle.v) > PROJECT_FILE_VERSION) {
    throw new Error(
      `This project was exported by a newer CoordRippr (format v${bundle.v}). Update the app and try again.`
    );
  }
  return {
    name: String((bundle.project && bundle.project.name) || 'Imported project'),
    snapshot: bundle.snapshot,
    exportedAt: typeof bundle.exportedAt === 'number' ? bundle.exportedAt : null,
    pdfs: (Array.isArray(bundle.pdfs) ? bundle.pdfs : [])
      .filter((f) => f && f.fileId && f.b64)
      .map((f) => ({
        fileId: String(f.fileId),
        name: String(f.name || `${f.fileId}.pdf`),
        bytes: base64ToBytes(f.b64),
      })),
  };
}

/**
 * A name no project in `existing` is already using: "Xantho", then
 * "Xantho (2)", "Xantho (3)", … Import never silently merges into or renames an
 * existing project.
 */
export function uniqueProjectName(name, existing = []) {
  const taken = new Set(existing.map((p) => (p && p.name ? p.name : '')));
  const base = String(name || 'Imported project').trim() || 'Imported project';
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}

/** Filesystem-safe default name for the export dialog. */
export function projectFileName(projectName) {
  const stem = String(projectName || 'project')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'project';
  return `${stem}.${PROJECT_FILE_EXT}`;
}

/**
 * Rough byte size of the bundle before building it, so the export dialog can
 * warn before spending a minute serialising a gigabyte. Base64 costs 4 bytes per
 * 3, plus JSON overhead.
 * @param {number} snapshotChars  JSON length of the snapshot
 * @param {number} pdfBytes       total size of the PDFs to embed
 */
export function estimateExportSize(snapshotChars, pdfBytes) {
  return Math.round(snapshotChars + pdfBytes * (4 / 3) + 1024);
}

/** Human-readable byte count for the dialog ("142 MB"). */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

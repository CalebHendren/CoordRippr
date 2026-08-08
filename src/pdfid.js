// CoordRippr duplicate-PDF detection. Pure module (no DOM/Electron; runs under
// node --test). Identity is content, never the file name: the same paper turns
// up as 168766.pdf and as Xenopygus_marginatus.pdf, and a copy re-saved by a
// different producer shares no bytes with the original but every word of its
// text. Two exact tiers, no similarity threshold — the caller reviews what this
// finds, so a false positive costs more than a miss.

// A document with no text layer (a scan) fingerprints to almost nothing, and
// every such PDF in a folder would then look like every other. Below this many
// normalised characters there is no text fingerprint at all and the document is
// matched byte-for-byte only.
export const MIN_TEXT_CHARS = 400;

/**
 * Page text reduced to the words themselves. Ligatures, hyphenation artefacts,
 * punctuation and the spacing pdf.js infers between text items all differ
 * between two renderings of the same paper; the letters and digits do not.
 */
export function normalizeDocText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

/**
 * One string standing for a whole document, or null when there is too little
 * text to identify it.
 *
 * @param {Array<string>} pageTexts one entry per page, in page order
 */
export function docFingerprint(pageTexts) {
  const joined = (pageTexts || []).map(normalizeDocText).filter(Boolean).join(' ');
  return joined.length >= MIN_TEXT_CHARS ? joined : null;
}

const HEX = (n) => n.toString(16).padStart(2, '0');

function toBytes(input) {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('hashHex needs a string, ArrayBuffer or typed array');
}

// Fallback for any runtime without WebCrypto: FNV-1a widened to 64 bits with
// BigInt. Weaker than SHA-256, but this only has to separate documents in one
// user's folder, and every match is shown for review before anything happens.
function fnv1a64(bytes) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const b of bytes) {
    h = ((h ^ BigInt(b)) * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * Hex digest of some bytes or a string. SHA-256 where WebCrypto exists (the
 * Electron file:// renderer is a secure context, the Pages build is https, and
 * Node has it), FNV-1a otherwise.
 */
export async function hashHex(input) {
  const bytes = toBytes(input);
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map(HEX).join('');
    } catch {
      // fall through to the pure-JS digest
    }
  }
  return fnv1a64(bytes);
}

// Files sharing a hash, in input order, first one kept. Hashless files are
// skipped rather than lumped together — "we don't know" is not "the same".
function groupBy(files, pick, skip) {
  const buckets = new Map();
  for (const f of files) {
    if (skip.has(f.id)) continue;
    const h = pick(f);
    if (!h) continue;
    if (!buckets.has(h)) buckets.set(h, []);
    buckets.get(h).push(f);
  }
  return [...buckets.values()].filter((g) => g.length > 1);
}

/**
 * Groups of PDFs that are the same document.
 *
 * Byte-identical files are found first and taken out of the running, so a pair
 * that matches both ways is reported once, under the stronger reason.
 *
 * @param {Array} files [{id, name, numPages, byteHash, textHash}]
 * @returns {Array<{reason: 'bytes'|'text', keep: string, dupes: string[]}>}
 */
export function findDuplicateFiles(files) {
  const list = files || [];
  const claimed = new Set();
  const out = [];
  const collect = (groups, reason) => {
    for (const g of groups) {
      for (const f of g) claimed.add(f.id);
      out.push({ reason, keep: g[0].id, dupes: g.slice(1).map((f) => f.id) });
    }
  };
  collect(groupBy(list, (f) => f.byteHash, claimed), 'bytes');
  collect(groupBy(list, (f) => f.textHash, claimed), 'text');
  return out;
}

/** How many files a set of groups would set aside. */
export function countDuplicates(groups) {
  return (groups || []).reduce((n, g) => n + g.dupes.length, 0);
}

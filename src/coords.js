// CoordRippr coordinate parsing / cleaning / formatting. Pure module (no DOM,
// no Electron); used by the renderer and node --test. A wide regex finds
// candidate tokens, parseToken() interprets them, pairTokens() assembles
// lat/lon pairs. False positives are tolerated (user deletes rows); bare
// numbers survive only when they pair into a plausible lat/lon couple.

// ---------------------------------------------------------------------------
// Character classes. PDFs are sloppy: any of these can stand in for °, ' , ".
// ---------------------------------------------------------------------------

// ° º ˚ ◦ ᵒ ⁰ ∘ (letter o/O handled separately: only valid touching the digits)
const DEG_MARKS = '°º˚◦ᵒ⁰∘';
// ' ′ ’ ‘ ` ´ ʹ ʼ ˊ ᾿ ‛
const MIN_MARKS = "'′’‘`´ʹʼˊ᾿‛";
// " ″ ” “ ʺ 〃 ‶
const SEC_MARKS = '"″”“ʺ〃‶';
// − – — ‐ ‑ ‒ - (ASCII hyphen deliberately last: inside [+…] a mid-class
// hyphen would silently become a huge character range)
const MINUS = '−–—‐‑‒-';

const D = `[${DEG_MARKS}]|[oO](?=[\\s ]{0,2}[\\d${MIN_MARKS}NSEWnsew])`;
const M = `[${MIN_MARKS}]`;
const S = `[${SEC_MARKS}]|[${MIN_MARKS}]{2}`;
// Horizontal whitespace only (space, tab, NBSP, thin spaces …) — NOT a newline.
const HS = `[^\\S\\n]`;
// Gap allowed between the parts of one coordinate token. PDFs wrap a coordinate
// across a line and the continuation is usually indented, so a token must be
// able to absorb a single line break plus that indentation — a flat {0,3} budget
// silently split "104°<newline>   43'46\"" into a bare "104°" (dropping the
// minutes/seconds). Allow a few same-line spaces, OR one line break bracketed by
// indentation.
const SP = `${HS}{0,3}(?:\\n${HS}{0,40})?`;
const NUM = `\\d{1,3}(?:[.,]\\d+)?`;
// Hemisphere words, plus the Spanish/Portuguese "Oeste" and French "Ouest"
// (West). The bare letter "O" for West is handled in the hemisphere character
// classes below, with a guard in parseToken (see hemiFromLoneO).
const HEMI_WORD =
  '[Nn]orth|[Ss]outh|[Ee]ast|[Ww]est|[Oo]este|[Oo]uest|[Ll]at(?:itude)?|[Ll]on(?:g(?:itude)?)?';

// One candidate coordinate token. Everything after the leading number is
// optional so the net stays wide; parseToken() applies the judgement.
const TOKEN_SRC =
  `(?:(?<wordpre>${HEMI_WORD})[.:]?${SP})?` +
  `(?:(?<hemipre>[NSEWO])[.]?${SP})?` +
  `(?<sign>[+${MINUS}])?${SP}` +
  `(?<![\\d.,])(?<deg>${NUM})(?![\\d])${SP}` +
  `(?<degmark>${D})?${SP}` +
  `(?:(?<![\\d.,])(?<min>\\d{1,2}(?:[.,]\\d+)?)(?![\\d])${SP}` +
  `(?:(?<secmark1>${S})|(?<minmark>${M}))?${SP}` +
  `(?:(?<![\\d.,])(?<sec>\\d{1,2}(?:[.,]\\d+)?)(?![\\d])${SP}(?<secmark2>${S})?)?` +
  `)?` +
  `(?:${SP}(?:(?<hemipost>[NSEWOnsew])(?![A-Za-z0-9])|(?<hemiword>${HEMI_WORD})(?![A-Za-z])))?`;

const TOKEN_REGEX = () => new RegExp(TOKEN_SRC, 'dg');

const HEMI_MAP = {
  n: 'N', s: 'S', e: 'E', w: 'W', o: 'W', // "O" = Oeste/Ouest (West)
  north: 'N', south: 'S', east: 'E', west: 'W', oeste: 'W', ouest: 'W',
  lat: null, latitude: null, lon: null, long: null, longitude: null,
};

// ---------------------------------------------------------------------------
// Intensity: detection-net width (1 = strictest … 7 = everything; 5 = default).
// The four strictest steps (1–4) give fine control over false positives; the
// pairing requirement loosens one notch at a time from "both halves strong".
// ---------------------------------------------------------------------------

export const DEFAULT_INTENSITY = 5;

export const INTENSITY_LABELS = {
  1: 'Strictest — both halves strong (°, hemisphere, …); nothing kept alone',
  2: 'Strict — both halves strong, but a lone strong coordinate is kept',
  3: 'Firm — a strong half pairs only with another solid (≥ medium) half',
  4: 'Careful — a strong half may pair with a weaker partner',
  5: 'Balanced — the classic CoordRippr net (default)',
  6: 'Wide — single-decimal numbers can pair, bigger gaps allowed',
  7: 'Everything — even bare integer pairs; expect false positives',
};

function intensityRules(level) {
  const l = Math.min(7, Math.max(1, Math.round(Number(level) || DEFAULT_INTENSITY)));
  return {
    level: l,
    // decimal digits needed for a bare number to count as a weak candidate
    weakDecimals: l >= 6 ? 1 : 2,
    // integers with no coordinate evidence at all become 'bare' candidates
    allowBare: l >= 7,
    // max chars between the two halves of a pair (index by level; [0] unused)
    maxGap: [0, 22, 26, 30, 36, 44, 64, 84][l],
    // how strong the two halves must be to pair, strict → loose:
    //  both-strong → strong+medium → one-strong → default (medium/weak-pair) → any
    pairNeeds:
      l <= 2 ? 'both-strong'
        : l === 3 ? 'strong+medium'
          : l === 4 ? 'one-strong'
            : l <= 6 ? 'default'
              : 'any',
    // whether an unpaired token survives on its own
    keepLone: l === 1 ? 'none' : l >= 7 ? 'strong+medium' : 'strong',
  };
}

function num(str) {
  if (str == null) return null;
  return parseFloat(str.replace(',', '.'));
}

// ---------------------------------------------------------------------------
// Token parsing
// ---------------------------------------------------------------------------

/**
 * Interpret one regex match. null when the match is a number with no
 * coordinate evidence — but a possible decimal degree returns a "weak" token
 * instead (used later by the bare-decimal-pair rule).
 */
function parseToken(m, text, rules) {
  const g = m.groups;
  const start = m.index;
  const end = m.index + m[0].length;
  const raw = m[0];

  let deg = num(g.deg);
  let min = num(g.min);
  let sec = num(g.sec);
  if (deg == null || Number.isNaN(deg)) return null;

  // Letter 'o' as a degree mark is only credible when it touches the digits:
  // "12o30'" yes — "12 o'clock" no.
  let hasDegMark = !!g.degmark;
  if (hasDegMark && /^[oO]$/.test(g.degmark)) {
    const degEnd = m.indices.groups.deg[1];
    const markStart = m.indices.groups.degmark[0];
    if (markStart !== degEnd) hasDegMark = false;
  }

  const hasMinMark = !!g.minmark;
  const hasSecMark = !!(g.secmark1 || g.secmark2);
  let hemi = null;
  let hemiFromLoneO = false; // the West came from a bare letter "O" (Oeste/Ouest)
  for (const h of [g.hemipre, g.hemipost, g.hemiword, g.wordpre]) {
    if (h) {
      const mapped = HEMI_MAP[h.toLowerCase()];
      if (mapped) { hemi = mapped; hemiFromLoneO = /^[oO]$/.test(h); break; }
    }
  }
  // A bare "O" is West only on a real coordinate — one carrying a degree mark,
  // minutes, or a decimal fraction. Otherwise stray text like "5 O." or a lone
  // capital O would masquerade as a longitude. Spelled-out "Oeste"/"Ouest" is
  // unambiguous and always kept.
  if (hemiFromLoneO && !g.degmark && min == null && !/[.,]/.test(g.deg)) { hemi = null; }
  // "lat"/"long" words pin the axis without giving a sign.
  let axisWord = null;
  for (const w0 of [g.hemiword, g.wordpre]) {
    if (!w0) continue;
    const w = w0.toLowerCase();
    if (w.startsWith('lat')) { axisWord = 'lat'; break; }
    if (w.startsWith('lon')) { axisWord = 'lon'; break; }
  }

  const negative = !!g.sign && g.sign !== '+';
  const degHasFraction = /[.,]/.test(g.deg);

  // Structure sanity: decimal degrees followed by minutes is nonsense —
  // drop the tail and treat as plain DD.
  if (degHasFraction && min != null) { min = null; sec = null; }
  // Range sanity for DMS parts.
  if (min != null && min >= 60) return null;
  if (sec != null && sec >= 60) return null;

  // Evidence scoring: what makes this look like a coordinate?
  const evidence =
    (hasDegMark ? 2 : 0) +
    (hemi ? 2 : 0) +
    (axisWord ? 1 : 0) +
    (hasMinMark || hasSecMark ? 1 : 0) +
    (min != null && sec != null ? 1 : 0);

  let dd = Math.abs(deg) + (min || 0) / 60 + (sec || 0) / 3600;
  if (negative || deg < 0) dd = -dd;
  if (hemi === 'S' || hemi === 'W') dd = -Math.abs(dd);

  if (Math.abs(dd) > 180) return null;

  let axis = null;
  if (hemi === 'N' || hemi === 'S') axis = 'lat';
  else if (hemi === 'E' || hemi === 'W') axis = 'lon';
  else if (axisWord) axis = axisWord;
  if (axis === 'lat' && Math.abs(dd) > 90) return null;

  const isDMS = min != null;
  // strong = stands alone; weak = bare number, counts only if paired; bare =
  // integer, only at highest intensity and only as half a pair.
  let strength;
  if (evidence >= 2) strength = 'strong';
  else if (evidence === 1 && (degHasFraction || isDMS)) strength = 'medium';
  else if (degHasFraction && g.deg.split(/[.,]/)[1].length >= rules.weakDecimals) strength = 'weak';
  else if (rules.allowBare) strength = 'bare';
  else return null; // bare integer with no evidence: not even wide-net worthy

  return {
    start, end, raw: raw.trim(),
    deg: Math.abs(deg), min, sec, hemi, negative: dd < 0,
    dd, axis, isDMS, strength,
    hasDegMark, hasMinMark, hasSecMark,
  };
}

/** Find every candidate token in a block of text. */
export function findTokens(text, intensity = DEFAULT_INTENSITY) {
  const rules = intensityRules(intensity);
  const re = TOKEN_REGEX();
  const tokens = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].trim() === '') { re.lastIndex = m.index + 1; continue; }
    const t = parseToken(m, text, rules);
    if (t) tokens.push(t);
    // Continue scanning right after the matched degrees number so an
    // absorbed neighbour can still be found if parseToken rejected this one.
    if (!t) re.lastIndex = m.indices.groups.deg[1];
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

function gapIsClean(text, a, b, maxGap) {
  const between = text.slice(a.end, b.start);
  if (between.length > maxGap) return false;
  if (/\d/.test(between)) return false; // another number lives in between
  // separators / connective tissue only
  return /^[\s ,;:/|()\[\]–—-]*(?:and|by|to|x)?[\s ,;:/|()\[\]–—-]*$/i.test(between);
}

function compatible(a, b) {
  if (a.axis && b.axis && a.axis === b.axis) return false;
  return true;
}

/**
 * Pair tokens into {lat, lon} coordinates. Unpaired strong tokens are kept
 * as half-empty pairs; unpaired weak tokens are discarded.
 */
export function pairTokens(tokens, text, intensity = DEFAULT_INTENSITY) {
  const rules = intensityRules(intensity);
  const pairs = [];
  const used = new Set();

  for (let i = 0; i < tokens.length; i++) {
    if (used.has(i)) continue;
    const a = tokens[i];
    const b = tokens[i + 1];

    if (b && !used.has(i + 1) && gapIsClean(text, a, b, rules.maxGap) && compatible(a, b)) {
      // Weak tokens must both be plausible decimal degrees to pair.
      const weakPair = a.strength === 'weak' && b.strength === 'weak';
      const isStrong = (t) => t.strength === 'strong';
      const isMediumUp = (t) => t.strength === 'strong' || t.strength === 'medium';
      const anyStrong = isStrong(a) || isStrong(b);
      let ok;
      if (rules.pairNeeds === 'both-strong') ok = isStrong(a) && isStrong(b);
      // One strong half, but its partner must still be solid (≥ medium) — no
      // strong-drags-a-bare-number pairing, which is the usual false-positive.
      else if (rules.pairNeeds === 'strong+medium') ok = (isStrong(a) && isMediumUp(b)) || (isStrong(b) && isMediumUp(a));
      else if (rules.pairNeeds === 'one-strong') ok = anyStrong;
      else if (rules.pairNeeds === 'any') ok = true; // everything: any two candidates may pair
      else ok = anyStrong || a.strength === 'medium' || b.strength === 'medium' || weakPair; // 'default'
      if (ok) {
        let lat = a, lon = b;
        if (a.axis === 'lon' || b.axis === 'lat') { lat = b; lon = a; }
        // No axis info: first is lat by convention, but ranges can veto.
        if (!a.axis && !b.axis) {
          if (Math.abs(a.dd) > 90 && Math.abs(b.dd) <= 90) { lat = b; lon = a; }
        }
        if (Math.abs(lat.dd) <= 90 && Math.abs(lon.dd) <= 180) {
          pairs.push({ lat, lon });
          used.add(i); used.add(i + 1);
          continue;
        }
      }
    }

    // Lone token: keep only if it can stand on its own.
    const loneOk =
      rules.keepLone === 'strong' ? a.strength === 'strong'
        : rules.keepLone === 'strong+medium' ? a.strength === 'strong' || a.strength === 'medium'
          : false;
    if (loneOk) {
      if (a.axis === 'lon' || Math.abs(a.dd) > 90) pairs.push({ lat: null, lon: a });
      else pairs.push({ lat: a, lon: null });
      used.add(i);
    }
  }
  return pairs;
}

/** One-call helper: text in, coordinate pairs out. */
export function extractCoordinates(text, intensity = DEFAULT_INTENSITY) {
  return pairTokens(findTokens(text, intensity), text, intensity);
}

// ---------------------------------------------------------------------------
// Cross-page pairs
// ---------------------------------------------------------------------------

// How many chars of the end of one page / start of the next to inspect.
export const CROSS_PAGE_WINDOW = 240;

/**
 * Coordinate pairs straddling the boundary between two consecutive pages (lat
 * at the bottom of one, lon at the top of the next, or a token split by the
 * break). Single-page pairs are ignored (the per-page scan has those).
 * Each returned token carries `segs`: its char ranges in each page's own text,
 * [{page: 'prev'|'next', start, end}, …].
 */
export function extractCrossPage(prevText, nextText, intensity = DEFAULT_INTENSITY, window = CROSS_PAGE_WINDOW) {
  const tailStart = Math.max(0, prevText.length - window);
  const tail = prevText.slice(tailStart);
  const head = nextText.slice(0, window);
  const joint = tail + '\n' + head;
  const boundary = tail.length; // index of the '\n' we inserted
  const out = [];
  for (const pair of extractCoordinates(joint, intensity)) {
    if (!pair.lat || !pair.lon) continue; // half-pairs can't span pages
    const s = Math.min(pair.lat.start, pair.lon.start);
    const e = Math.max(pair.lat.end, pair.lon.end);
    if (!(s < boundary && e > boundary + 1)) continue; // must actually cross
    out.push({
      lat: withSegments(pair.lat, boundary, tailStart),
      lon: withSegments(pair.lon, boundary, tailStart),
    });
  }
  return out;
}

// Map a token found in the joined tail+head text back onto the two pages.
function withSegments(tok, boundary, tailStart) {
  const segs = [];
  if (tok.start < boundary) {
    segs.push({
      page: 'prev',
      start: tailStart + tok.start,
      end: tailStart + Math.min(tok.end, boundary),
    });
  }
  if (tok.end > boundary + 1) {
    segs.push({
      page: 'next',
      start: Math.max(0, tok.start - boundary - 1),
      end: tok.end - boundary - 1,
    });
  }
  return { ...tok, segs };
}

// ---------------------------------------------------------------------------
// Cleaning / formatting
// ---------------------------------------------------------------------------

/** Parse a single user-typed cell value into decimal degrees (or null). */
export function parseSingle(text, axis = null) {
  if (text == null) return null;
  const s = String(text).trim();
  if (s === '') return null;
  // Fast path: plain float
  if (/^[+-]?\d{1,3}(\.\d+)?$/.test(s)) {
    const v = parseFloat(s);
    if (Math.abs(v) <= (axis === 'lat' ? 90 : 180)) return v;
    return null;
  }
  const tokens = findTokens(s);
  if (tokens.length === 0) return null;
  const t = tokens[0];
  if (axis === 'lat' && Math.abs(t.dd) > 90) return null;
  if (Math.abs(t.dd) > 180) return null;
  return t.dd;
}

/** Format decimal degrees as a clean DD string. */
export function formatDD(dd) {
  if (dd == null || Number.isNaN(dd)) return '';
  return dd.toFixed(6).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
}

/** Format decimal degrees as a clean DMS string, e.g. 41°24'12.20"N */
export function formatDMS(dd, axis) {
  if (dd == null || Number.isNaN(dd)) return '';
  const hemi = axis === 'lon' ? (dd < 0 ? 'W' : 'E') : (dd < 0 ? 'S' : 'N');
  let abs = Math.abs(dd);
  let deg = Math.floor(abs);
  let minFloat = (abs - deg) * 60;
  let min = Math.floor(minFloat);
  let sec = (minFloat - min) * 60;
  // Guard against 59.999999 rounding up.
  if (Number(sec.toFixed(2)) >= 60) { sec = 0; min += 1; }
  if (min >= 60) { min = 0; deg += 1; }
  const secStr = sec.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  return `${deg}°${String(min).padStart(2, '0')}'${secStr.padStart(2, '0')}"${hemi}`;
}

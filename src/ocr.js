// OCR glue for scanned (image-only) PDFs. Pure module (node --test): decides
// which pages need OCR, turns Tesseract's word boxes into a pdf.js-shaped
// textContent so buildPageText/rectsForRange and the coordinate parser work on
// a scan as they do on a born-digital PDF, and repairs the misreads OCR makes
// in coordinates. The engine (rendering pages, running tesseract.js) is in
// ocrengine.js.

// A page with fewer non-space characters than this in its text layer counts
// as having none. Scans often carry a stray running header, a page number or a
// scanner's stamp; a real page of text has hundreds.
export const MIN_TEXT_LAYER_CHARS = 40;

// Render scale for OCR: 300 dpi, where Tesseract's LSTM models do best.
export const OCR_DPI = 300;
export const OCR_SCALE = OCR_DPI / 72;

// Digit-free words Tesseract is less sure of than this are dropped: on a scan
// they are mostly specks, the spine shadow or figure texture read as letters.
// Words with a digit are always kept. Tesseract is at its least confident on
// exactly the words this app is after (4°36"35"N scores 8 of 100), and a
// stray number on its own never becomes a row.
export const MIN_WORD_CONFIDENCE = 30;

// Running heads and page numbers: a line ending this close to the top of the
// page, or starting this close to the bottom, is moved to the start of the page
// text so it does not sit between a coordinate split across a page break.
export const HEADER_BAND = 0.08;
export const FOOTER_BAND = 0.94;

// Per-PDF OCR mode: 'auto' OCRs the pages without a text layer, 'off' never
// OCRs, 'force' OCRs every page (for PDFs whose text layer is garbage).
export const OCR_MODES = ['auto', 'off', 'force'];

/** Whether a pdf.js textContent amounts to a text layer (see MIN_TEXT_LAYER_CHARS). */
export function hasTextLayer(textContent) {
  let n = 0;
  for (const item of (textContent && textContent.items) || []) {
    if (item.str) n += item.str.replace(/\s+/g, '').length;
    if (n >= MIN_TEXT_LAYER_CHARS) return true;
  }
  return false;
}

/**
 * Whether a page should be read by OCR. `noText` is true when the page has no
 * text layer, `mode` the PDF's OCR mode, `enabled` the app-wide switch. A
 * forced PDF is OCR'd even with the switch off: the user asked for that one.
 */
export function wantsOcr(noText, mode = 'auto', enabled = true) {
  if (mode === 'force') return true;
  if (mode === 'off' || !enabled) return false;
  return !!noText;
}

// ---------------------------------------------------------------------------
// Coordinate misreads
// ---------------------------------------------------------------------------

const DEG = '°º˚';
const MARK_RE = /[°º˚'′’‘`´"″”“]/;
const PRIME = "'";
const DPRIME = '"';

/**
 * Repair the ways Tesseract garbles a coordinate, one line at a time. Only
 * words that already look like part of a coordinate are touched (a digit plus
 * a degree mark, or a word continuing one), so prose, years and page ranges
 * pass through unchanged. Returns new strings, one per input word.
 *
 * - Every mark after the degree mark is re-typed by position: the first is
 *   minutes, the second seconds. OCR reads ′ and ″ as °, " or ', so
 *   0°40°27°S, 4°36"35"N and 71°58°W all come out as D°M'S".
 * - Primes dropped between glued digits: 0°1503" is 0°15'03".
 * - A degree sign read as a zero: 79053'W is 79°53'W, 2010'S is 2°10'S
 *   (only before a minute mark and an upper-case hemisphere).
 * - I, l or | read for a one beside digits or a degree mark: IDeg 29'S.
 * - S read for a five between a mark and a digit: 77°48'S0'W.
 */
export function normalizeOcrWords(words) {
  const out = [];
  // Digit groups seen since the degree mark of the coordinate in progress, or
  // -1 when none is open. The mark after the first group is the minutes', after
  // the second the seconds'. A coordinate can run on into the next word
  // ("76°23 52°W": the prime was lost, the double prime read as °).
  let groups = -1;
  for (const w of words) {
    const s = fixZeroDegree(fixLetterDigits(w));
    if (groups >= 0 && !/^[(\[]?\d/.test(s)) groups = -1;
    let res = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const prev = s[i - 1] || '';
      if (groups < 0) {
        if (DEG.includes(c) && /\d/.test(prev)) groups = 0;
        res += c;
        continue;
      }
      if (/\d/.test(c) && !/[\d.,]/.test(prev)) {
        // Minutes and seconds glued together with both primes lost: 1503".
        const glued = groups === 0 && /^(\d{2})(\d{2}(?:[.,]\d+)?)["″”“]/.exec(s.slice(i));
        if (glued) {
          res += `${glued[1]}${PRIME}${glued[2]}${DPRIME}`;
          i += glued[0].length - 1;
          groups = -1;
          continue;
        }
        groups++;
      } else if (MARK_RE.test(c) && /[\d.,]/.test(prev) && groups >= 1) {
        // A doubled tick ('' for ″) is one mark.
        if ("'′’".includes(c) && s[i + 1] === c) i++;
        res += groups === 1 ? PRIME : DPRIME;
        if (groups >= 2) groups = -1; // seconds close the coordinate
        continue;
      } else if (!/[\d.,]/.test(c)) {
        groups = -1; // a hemisphere, bracket or letter ends the coordinate
      }
      if (groups > 2) groups = -1;
      res += c;
    }
    // Only a word ending in a digit or a mark can continue into the next.
    if (!/[\d°º˚'′’"″”“]$/.test(s)) groups = -1;
    out.push(fixAfterMarks(res));
  }
  return out;
}

// Letter-for-digit and speck repairs around the digits of a coordinate:
// I, l and | for 1 where they touch digits or a degree mark; S for 5 between
// a mark and a digit that is itself followed by a mark; a speck read as a full
// stop before the degrees (".0°13'07\"S" would otherwise fail the parser's
// no-decimal-before-degrees guard); a speck read as $ after a lone hemisphere
// letter.
function fixLetterDigits(s) {
  if (/^[NSEW][$§]$/.test(s)) return s[0];
  if (!/\d|[Dd]eg/.test(s)) return s;
  return s
    .replace(/(?<=\d)[Il|](?=\d)/g, '1')
    .replace(/(?<![A-Za-z])[Il|](?=\d|[°º˚]|Deg)/g, '1')
    .replace(/(?<=\d)[Il|](?=[°º˚'′’])/g, '1')
    .replace(/(?<=[°º˚'′’])S(?=\d['′’"″”])/g, '5')
    .replace(/^([(\[]?)[.,·:;‘’'`]+(?=\d{1,3}[°º˚])/, '$1');
}

// After the marks are re-typed: a hemisphere glued to the next coordinate
// (27"S76°), and O for West read as a zero (79°12'0).
function fixAfterMarks(s) {
  return s
    .replace(/(?<=\d['"][NSEW])(?=\d)/g, ' ')
    .replace(/(?<=\d')0$/, 'O');
}

// A degree written as the letter o and read back as the digit 0: the digits
// before a minute mark split as degrees + 0 + two minute digits.
function fixZeroDegree(s) {
  return s.replace(
    /(?<![\d.,°º˚])(\d{1,3})0(\d{2})(?=['′’][,;)]?$|['′’]\s?[NSEW](?![a-z]))/g,
    (all, d, m) => (Number(d) <= 180 && Number(m) < 60 ? `${d}°${m}` : all),
  );
}

// ---------------------------------------------------------------------------
// Word boxes -> textContent
// ---------------------------------------------------------------------------

/**
 * Tesseract result -> compact word list in PDF user space (points, y up), one
 * entry per word: [str, x, y, w, h, eol]. `y` is the baseline and `h` the glyph
 * height that rectsForRange expects (its box runs 0.28 h below the baseline to
 * 1.02 h above, so the highlight covers the line's ascenders and descenders).
 *
 * Vertical geometry comes from the line, not the word: words on one line share
 * a height and sit on the line's sloped baseline. Word boxes vary with their
 * letters (a lone "-" is tiny, "gy" hangs low) and buildPageText would read
 * those jumps as line breaks.
 *
 * Tesseract reports boxes on the deskewed image when it straightened the page
 * (rotateAuto); `angle` (its rotateRadians) turns them back onto the page as
 * scanned, which is what the viewer shows.
 *
 * @param {object} data  tesseract.js recognize() data with `blocks`
 * @param {object} page  {scale (pixels per point), pageW, pageH (points),
 *                        angle (radians), minConf}
 */
export function wordsFromOcr(data, { scale, pageW, pageH, angle = 0, minConf = MIN_WORD_CONFIDENCE }) {
  const imgH = pageH * scale;
  const cx = (pageW * scale) / 2;
  const cy = imgH / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Deskewed image point -> scanned image point.
  const unrotate = (x, y) => [
    cx + (x - cx) * cos + (y - cy) * sin,
    cy - (x - cx) * sin + (y - cy) * cos,
  ];
  const body = [];
  const margin = [];
  for (const line of ocrLines(data)) {
    const words = (line.words || [])
      .filter((w) => w && w.text && w.text.trim() && w.bbox)
      .filter((w) => /\d/.test(w.text) || (w.confidence ?? 100) >= minConf)
      .sort((a, b) => a.bbox.x0 - b.bbox.x0);
    if (words.length === 0) continue;
    const top = Math.min(...words.map((w) => w.bbox.y0));
    const bottom = Math.max(...words.map((w) => w.bbox.y1));
    const texts = normalizeOcrWords(words.map((w) => w.text.trim()));

    const base = line.baseline && Number.isFinite(line.baseline.y0) ? line.baseline : null;
    const slope = base && base.x1 !== base.x0 ? (base.y1 - base.y0) / (base.x1 - base.x0) : 0;
    const ra = line.rowAttributes;
    const rowH = ra && ra.rowHeight > 0 ? ra.rowHeight : bottom - top;
    const desc = ra && ra.descenders >= 0 ? ra.descenders : rowH * 0.22;
    // Bottom of the line's box (descender line) at image x, y down.
    const bottomAt = (x) => (base ? base.y0 + slope * (x - base.x0) + desc : bottom);
    const h = rowH / scale / 1.3;

    const out = words.map((w, i) => {
      const mid = (w.bbox.x0 + w.bbox.x1) / 2;
      // The box's bottom-left corner, moved with the box's centre.
      const [mx, my] = unrotate(mid, bottomAt(mid) - rowH / 2);
      const x0 = mx - (w.bbox.x1 - w.bbox.x0) / 2;
      const y1 = my + rowH / 2;
      return [
        texts[i],
        round2(x0 / scale),
        round2(pageH - y1 / scale + h * 0.28),
        round2((w.bbox.x1 - w.bbox.x0) / scale),
        round2(h),
        i === words.length - 1 ? 1 : 0,
      ];
    });
    if (bottom < imgH * HEADER_BAND || top > imgH * FOOTER_BAND) {
      for (const word of out) word.push(1);
      margin.push(...out);
    } else {
      body.push(...out);
    }
  }
  return [...margin, ...body];
}

/**
 * Compact word list -> pdf.js-shaped textContent for buildPageText. Running
 * heads and page numbers (moved to the front by wordsFromOcr) carry
 * `margin: true`; see bodyStart.
 */
export function ocrTextContent(words) {
  return {
    items: (words || []).map(([str, x, y, w, h, eol, margin]) => ({
      str,
      transform: [h, 0, 0, h, x, y],
      width: w,
      height: h,
      hasEOL: !!eol,
      ocr: true,
      ...(margin ? { margin: true } : {}),
    })),
  };
}

/**
 * Offset in buildPageText's text where the page body starts, after any running
 * head or page number. A pair split across a page break is looked for from
 * here (extractCrossPage's nextStart). 0 for a text-layer page.
 */
export function bodyStart(spans) {
  for (const span of spans || []) {
    if (!span.item.margin) return span.start;
  }
  return 0;
}

// Lines in reading order. tesseract.js nests them block > paragraph > line;
// a result without blocks may list lines flat.
function ocrLines(data) {
  if (!data) return [];
  if (Array.isArray(data.blocks)) {
    const lines = [];
    for (const b of data.blocks) {
      for (const p of b.paragraphs || []) lines.push(...(p.lines || []));
    }
    return lines;
  }
  return Array.isArray(data.lines) ? data.lines : [];
}

const round2 = (n) => Math.round(n * 100) / 100;

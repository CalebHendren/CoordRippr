// CoordRippr PDF output: minimal PDF writer wrapping one JPEG per page — saves
// "highlighted" copies of scanned PDFs (each page rendered to canvas with
// highlights baked in, JPEG-encoded, embedded here) and searchable copies of
// OCR'd ones (the page image plus an invisible text layer, the way OCR
// software writes them). Pure module (node --test).

const enc = new TextEncoder();

const fmt = (n) => {
  const s = Number(n).toFixed(2);
  return s.endsWith('.00') ? s.slice(0, -3) : s;
};

// Courier: every glyph is 0.6 em wide, so stretching a word to its box needs
// no font metrics. The text is invisible; only its position matters.
const COURIER_ADVANCE = 0.6;

// Unicode -> WinAnsiEncoding byte for the invisible text. Latin-1 maps to
// itself; typographic quotes and dashes have their own slots; primes become
// plain ticks so a search for 0°13'07" finds 0°13′07″. Anything else is "?".
const WIN_ANSI = {
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '–': 0x96, '—': 0x97,
  '′': 0x27, '″': 0x22, '−': 0x2d, '•': 0x95, '…': 0x85,
};

function winAnsi(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    let b = WIN_ANSI[ch];
    if (b == null) b = (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) ? c : 0x3f;
    // Escape the string delimiters and the escape character itself.
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
    out.push(b);
  }
  return out;
}

/**
 * Content stream for an invisible text layer (render mode 3): each word set
 * at its baseline in Courier, stretched horizontally to its width.
 * @param {Array<Array>} words [str, x, baseline y, width, height, …] in page
 *   points, y up (the ocr.js word list; extra entries are ignored)
 * @returns {Uint8Array} stream bytes
 */
export function textLayerStream(words) {
  const bytes = [];
  const add = (s) => { for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i)); };
  add('BT\n3 Tr\n');
  for (const [str, x, y, w, h] of words || []) {
    const chars = [...(str || '')].length;
    if (!chars || !(h > 0) || !(w > 0)) continue;
    const scale = (100 * w) / (chars * COURIER_ADVANCE * h);
    add(`/F1 ${fmt(h)} Tf ${fmt(scale)} Tz 1 0 0 1 ${fmt(x)} ${fmt(y)} Tm (`);
    bytes.push(...winAnsi(str));
    add(') Tj\n');
  }
  add('ET\n');
  return Uint8Array.from(bytes);
}

/**
 * Build a complete PDF from pre-rendered page images.
 *
 * @param {Array<{w:number, h:number, pw:number, ph:number, jpeg:Uint8Array, words?:Array}>} pages
 *   w/h  — page size in PDF points (the original page's MediaBox)
 *   pw/ph — pixel dimensions of the JPEG
 *   jpeg — the encoded image bytes
 *   words — optional invisible text layer (see textLayerStream)
 * @returns {Uint8Array} the PDF file bytes
 */
export function buildImagePdf(pages) {
  if (!pages || pages.length === 0) throw new Error('No pages to write');
  const parts = [];
  let offset = 0;
  const offsets = []; // object number -> byte offset
  const push = (bytes) => { parts.push(bytes); offset += bytes.length; };
  const pushStr = (s) => push(enc.encode(s));
  const beginObj = (num) => { offsets[num] = offset; pushStr(`${num} 0 obj\n`); };

  // Object layout: 1 = Catalog, 2 = Pages, then per page k (0-based):
  // 3+3k = Page, 4+3k = Contents stream, 5+3k = Image XObject; last, the one
  // font, when any page has a text layer.
  const pageObj = (k) => 3 + k * 3;
  const hasText = pages.some((p) => p.words && p.words.length);
  const fontObj = 3 + pages.length * 3;
  const numObjects = 2 + pages.length * 3 + (hasText ? 1 : 0);

  pushStr('%PDF-1.4\n%ÿÿÿÿ\n');

  beginObj(1);
  pushStr('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObj(2);
  const kids = pages.map((_, k) => `${pageObj(k)} 0 R`).join(' ');
  pushStr(`<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>\nendobj\n`);

  pages.forEach((p, k) => {
    const [page, content, image] = [pageObj(k), pageObj(k) + 1, pageObj(k) + 2];
    const text = p.words && p.words.length ? textLayerStream(p.words) : null;
    const font = text ? ` /Font << /F1 ${fontObj} 0 R >>` : '';
    beginObj(page);
    pushStr(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(p.w)} ${fmt(p.h)}] ` +
      `/Contents ${content} 0 R /Resources << /XObject << /Im0 ${image} 0 R >>${font} >> >>\nendobj\n`
    );

    const draw = enc.encode(`q\n${fmt(p.w)} 0 0 ${fmt(p.h)} 0 0 cm\n/Im0 Do\nQ\n`);
    const stream = text ? concat([draw, text]) : draw;
    beginObj(content);
    pushStr(`<< /Length ${stream.length} >>\nstream\n`);
    push(stream);
    pushStr('endstream\nendobj\n');

    beginObj(image);
    pushStr(
      `<< /Type /XObject /Subtype /Image /Width ${p.pw} /Height ${p.ph} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`
    );
    push(p.jpeg);
    pushStr('\nendstream\nendobj\n');
  });

  if (hasText) {
    beginObj(fontObj);
    pushStr('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>\nendobj\n');
  }

  const xrefOffset = offset;
  pushStr(`xref\n0 ${numObjects + 1}\n0000000000 65535 f \n`);
  for (let n = 1; n <= numObjects; n++) {
    pushStr(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  }
  pushStr(`trailer\n<< /Size ${numObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return concat(parts);
}

function concat(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

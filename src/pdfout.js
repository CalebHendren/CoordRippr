// CoordRippr PDF output: a minimal PDF writer that wraps one JPEG image per
// page — used to save "highlighted" copies of scanned PDFs (each page is
// rendered to a canvas with its detection highlights baked in, encoded as
// JPEG, and embedded here). Pure module — no DOM, no Electron — so it runs
// under node --test.

const enc = new TextEncoder();

const fmt = (n) => {
  const s = Number(n).toFixed(2);
  return s.endsWith('.00') ? s.slice(0, -3) : s;
};

/**
 * Build a complete PDF from pre-rendered page images.
 *
 * @param {Array<{w:number, h:number, pw:number, ph:number, jpeg:Uint8Array}>} pages
 *   w/h  — page size in PDF points (the original page's MediaBox)
 *   pw/ph — pixel dimensions of the JPEG
 *   jpeg — the encoded image bytes
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
  // 3+3k = Page, 4+3k = Contents stream, 5+3k = Image XObject.
  const pageObj = (k) => 3 + k * 3;
  const numObjects = 2 + pages.length * 3;

  pushStr('%PDF-1.4\n%ÿÿÿÿ\n');

  beginObj(1);
  pushStr('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObj(2);
  const kids = pages.map((_, k) => `${pageObj(k)} 0 R`).join(' ');
  pushStr(`<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>\nendobj\n`);

  pages.forEach((p, k) => {
    const [page, content, image] = [pageObj(k), pageObj(k) + 1, pageObj(k) + 2];
    beginObj(page);
    pushStr(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(p.w)} ${fmt(p.h)}] ` +
      `/Contents ${content} 0 R /Resources << /XObject << /Im0 ${image} 0 R >> >> >>\nendobj\n`
    );

    const stream = `q\n${fmt(p.w)} 0 0 ${fmt(p.h)} 0 0 cm\n/Im0 Do\nQ\n`;
    beginObj(content);
    pushStr(`<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`);

    beginObj(image);
    pushStr(
      `<< /Type /XObject /Subtype /Image /Width ${p.pw} /Height ${p.ph} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`
    );
    push(p.jpeg);
    pushStr('\nendstream\nendobj\n');
  });

  const xrefOffset = offset;
  pushStr(`xref\n0 ${numObjects + 1}\n0000000000 65535 f \n`);
  for (let n = 1; n <= numObjects; n++) {
    pushStr(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  }
  pushStr(`trailer\n<< /Size ${numObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

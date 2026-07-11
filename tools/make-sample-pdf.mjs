// Generates test/fixtures/sample.pdf — a two-column "journal article" page
// with coordinates in deliberately messy formats, plus a second page without
// any coordinates. Run: node tools/make-sample-pdf.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(__dirname, '..', 'test', 'fixtures', 'sample.pdf');

// WinAnsi bytes: ° = \xB0
const DEG = '\xB0';

function esc(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function textOps(lines) {
  let ops = 'BT\n/F1 10 Tf\n';
  for (const [x, y, s] of lines) {
    ops += `1 0 0 1 ${x} ${y} Tm (${esc(s)}) Tj\n`;
  }
  return ops + 'ET\n';
}

// Page 1: two columns, several coordinate styles, one pair broken across lines.
const col1 = [
  [50, 740, 'Sampling of littoral fauna in the western'],
  [50, 726, 'Mediterranean. Specimens were collected'],
  [50, 712, `at 41${DEG}24'12.2"N 2${DEG}10'26.5"E during`],
  [50, 698, 'the spring survey of 2019. A second site'],
  [50, 684, 'near the harbour entrance was sampled'],
  [50, 670, 'twice (see Table 2 for full station data).'],
  [50, 656, 'Additional material came from 12o30\'N,'],
  [50, 642, '45o15\'W in the central Atlantic basin.'],
];
const col2 = [
  [320, 740, 'Station C lies offshore at -33.865143,'],
  [320, 726, '151.209900 in water 22 m deep. The'],
  [320, 712, 'reference locality (40 26 46.0 N,'],
  [320, 698, '79 58 56.0 W) follows Smith (2004).'],
  [320, 684, `A final record from Lat. 33.8688 S,`],
  [320, 670, `Long. 151.2093 E completes the set;`],
  [320, 656, 'voucher numbers 120-134 are listed'],
  [320, 642, 'in Appendix A, figs. 2, 3 and 7.'],
];
const page1 = textOps([...col1, ...col2]);

// Page 2: prose only — must produce zero detections.
const page2 = textOps([
  [50, 740, 'Discussion. In 2019 we sampled 45 sites'],
  [50, 726, 'over 12 days at depths of 300 m or less.'],
  [50, 712, 'No coordinates appear on this page.'],
]);

function buildPdf(pageStreams) {
  const objects = [];
  const kids = pageStreams.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageStreams.length} >>\nendobj\n`;
  objects[3] = `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`;
  pageStreams.forEach((stream, i) => {
    const pageNum = 4 + i * 2;
    const contentNum = pageNum + 1;
    objects[pageNum] =
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`;
    objects[contentNum] =
      `${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
  });

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = pdf.length;
    pdf += objects[i];
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buildPdf([page1, page2]));
console.log(`wrote ${out}`);

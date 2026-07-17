// Generates a two-column "journal article" demo page used for the README
// screenshot. It deliberately mixes clean and awful coordinate formats with
// look-alike numbers (years, depths, voucher ranges, figure/table refs) so the
// detector shows a realistic spread of good hits, messy hits and false alarms.
// Run: node tools/make-demo-pdf.mjs [outfile]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || path.join(__dirname, '..', 'test', 'fixtures', 'demo.pdf');

const DEG = '\xB0'; // ° in WinAnsi

function esc(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Each line: [x, y, size, text]. One BT/ET block, font set per line.
function textOps(lines) {
  let ops = '';
  for (const [x, y, size, s] of lines) {
    ops += `BT\n/F1 ${size} Tf\n1 0 0 1 ${x} ${y} Tm (${esc(s)}) Tj\nET\n`;
  }
  return ops;
}

// Title + byline span the full page width.
const head = [
  [56, 748, 15, 'Littoral macrofauna of the western Mediterranean'],
  [56, 730, 15, 'and adjacent Atlantic basins: a station gazetteer'],
  [56, 710, 10, 'A. Marlowe, R. Okonkwo & J. Halvorsen  ·  Journal of Coastal Benthos 48 (2019) 211-238'],
  [56, 694, 9, 'Received 3 March 2019; accepted 18 August 2019. Vouchers 120-134 deposited at the National Museum (Table 2).'],
];

// Left column — messy but mostly recoverable coordinates.
const col1 = [
  [56, 664, 11, 'Abstract'],
  [56, 648, 9, 'Specimens of littoral fauna were collected along'],
  [56, 636, 9, `the Catalan coast at 41${DEG}24'12.2"N 2${DEG}10'26.5"E`],
  [56, 624, 9, 'during the spring survey of 2019. A second site'],
  [56, 612, 9, 'near the harbour lay a few hundred metres east,'],
  [56, 600, 9, 'in water 22 m deep (see fig. 2). Offshore material'],
  [56, 588, 9, 'came from Station C at -33.865143, 151.209900'],
  [56, 576, 9, 'and from a reference locality at 40 26 46.0 N,'],
  [56, 564, 9, '79 58 56.0 W following Smith (2004). Additional'],
  [56, 552, 9, "records were logged near 12o30'N, 45o15'W in the"],
  [56, 540, 9, 'central Atlantic, and off Sydney at Lat. 33.8688 S,'],
  [56, 528, 9, 'Long. 151.2093 E. Depths ranged 3-300 m across'],
  [56, 516, 9, '45 stations sampled over 12 days (figs. 2, 3, 7).'],
];

// Right column — clean rows plus a couple of genuinely broken ones.
const col2 = [
  [320, 664, 11, 'Station gazetteer'],
  [320, 648, 9, 'St. 1  Barcelona shelf  Ostrea edulis, gravel;'],
  [320, 636, 9, `41${DEG}23'N 2${DEG}11'E, 15 m, 12 May 2019.`],
  [320, 624, 9, 'St. 2  Blanes canyon  Munida rugosa, mud;'],
  [320, 612, 9, `41.6743${DEG} N, 2.7889${DEG} E, 41 m.`],
  [320, 600, 9, 'St. 3  Cabrera  Posidonia meadow; sampled at'],
  [320, 588, 9, "39 08 30 N 2 56 10 E, quadrats 1-8, fig. 3."],
  [320, 576, 9, 'St. 4  Alboran  Charonia lampas on rock at'],
  [320, 564, 9, `35${DEG}56'N, 3${DEG}02'W (chart datum uncertain).`],
  [320, 552, 9, 'St. 5  suspect fix, GPS drift: 95.5000 N,'],
  [320, 540, 9, '12.0000 E (rejected; outside plausible range).'],
  [320, 528, 9, 'St. 6  transcription error in log: 48.137, -1XX.42'],
  [320, 516, 9, 'St. 7  Faial, Azores  38 32 N 28 37 W, 60 m.'],
];

const page1 = head.concat(col1, col2);

// A second, coordinate-free page (discussion) so the demo has more than one page.
const page2 = [
  [56, 748, 11, 'Discussion'],
  [56, 730, 9, 'Across the 2019 season we occupied 45 stations over 12 days, at depths of 300 m or less.'],
  [56, 718, 9, 'Sampling effort, voucher ranges (120-134) and figure references appear in Table 2; no'],
  [56, 706, 9, 'geographic coordinates are reported on this page. Nomenclature follows Smith (2004).'],
];

function buildPdf(pages) {
  const objects = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`;
  objects[3] = `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`;
  pages.forEach((lines, i) => {
    const pageNum = 4 + i * 2;
    const contentNum = pageNum + 1;
    const stream = textOps(lines);
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

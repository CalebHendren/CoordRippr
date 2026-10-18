// Generates docs/demo.pdf, the two-page "journal article" used for the README
// screenshot. Placeholder (lorem ipsum) prose in two justified columns, with one
// coordinate written in each of the messy forms the detector understands, plus
// a few look-alike numbers (years, elevations, page ranges, "at least 14") that
// it must ignore. Every form is found at the Balanced net (level 7); see
// test/demo-pdf.test.js.
//
// Page 1: masthead, title, abstract, introduction, start of the methods. The
// last line of page 1 ends mid-pair so the pair is completed on page 2.
// Page 2: station table, results, a PyMappr map as Figure 1, discussion,
// references.
//
// Run: node tools/make-demo-pdf.mjs [outfile]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIMES_ROMAN, TIMES_BOLD, TIMES_ITALIC } from './demo-font-metrics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || path.join(__dirname, '..', 'docs', 'demo.pdf');
const FIGURE = path.join(__dirname, 'demo-figure.jpg'); // PyMappr gallery map

// ---------------------------------------------------------------------------
// Page geometry (US Letter, points)
// ---------------------------------------------------------------------------

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const GUTTER = 14;
const FULL_W = PAGE_W - 2 * MARGIN;
const COL_W = (FULL_W - GUTTER) / 2;
const COL_X = [MARGIN, MARGIN + COL_W + GUTTER];
const TOP = 730; // first text line hangs below this, under the running head
const BOTTOM = 62;

// ---------------------------------------------------------------------------
// Fonts. F1-F3 are the standard Times faces in WinAnsi, with two extra glyphs
// (˚ ring, − minus) slotted into unused codes. F4 is Symbol, the only standard
// font with true prime marks (′ ″). Widths come from the AFM metrics so lines
// can be justified.
// ---------------------------------------------------------------------------

const NBSP = ' ';
const FONT = {
  R: { name: 'F1', w: TIMES_ROMAN },
  B: { name: 'F2', w: TIMES_BOLD },
  I: { name: 'F3', w: TIMES_ITALIC },
};
const EXTRA = { '˚': [0x81, { R: 333, B: 333, I: 333 }], '−': [0x8D, { R: 564, B: 570, I: 675 }] };
const SYMBOL = { '′': [0xA2, 247], '″': [0xB2, 411] };
const CP1252 = { '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97 };

function glyph(ch, style) {
  if (SYMBOL[ch]) return { font: 'F4', code: SYMBOL[ch][0], w: SYMBOL[ch][1] };
  const f = FONT[style];
  if (EXTRA[ch]) return { font: f.name, code: EXTRA[ch][0], w: EXTRA[ch][1][style] };
  const cp = ch.codePointAt(0);
  const code = ch === NBSP ? 32 : CP1252[ch] ?? cp;
  if (code < 32 || code > 255) throw new Error(`no glyph for ${JSON.stringify(ch)}`);
  return { font: f.name, code, w: f.w[code - 32] };
}

// Rich text: _italic_, ^bold^, ~ = non-breaking space, \n = forced line break,
// \f = forced line break that also ends the column.
function tokenize(src, base) {
  const toks = [];
  let word = null;
  let ital = false;
  let bold = false;
  const style = () => (bold ? 'B' : ital ? (base === 'I' ? 'R' : 'I') : base);
  const flush = () => { if (word) toks.push(word); word = null; };
  for (const ch of src) {
    if (ch === '_') { ital = !ital; continue; }
    if (ch === '^') { bold = !bold; continue; }
    if (ch === ' ') { flush(); continue; }
    if (ch === '\n' || ch === '\f') { flush(); toks.push({ brk: ch }); continue; }
    const g = glyph(ch === '~' ? NBSP : ch, style());
    word ??= { glyphs: [], w: 0 };
    word.glyphs.push(g);
    word.w += g.w;
  }
  flush();
  return toks;
}

const SPACE_W = 250; // the same in every Times face

// Greedy line breaking. Widths are in 1/1000 em until lineOps scales them.
function breakLines(para, width) {
  const lines = [];
  let cur = [];
  let curW = 0;
  const offset = () => (lines.length === 0 ? para.indent || 0 : para.hang || 0);
  const avail = () => ((width - offset()) * 1000) / para.size;
  const emit = (end) => {
    lines.push({ words: cur, w: curW, end, offset: offset(), fill: curW / avail() });
    cur = [];
    curW = 0;
  };
  for (const t of tokenize(para.text, para.style || 'R')) {
    if (t.brk) { emit(t.brk); continue; }
    if (cur.length && curW + SPACE_W + t.w > avail()) emit(null);
    curW += (cur.length ? SPACE_W : 0) + t.w;
    cur.push(t);
  }
  if (cur.length) emit('last');
  return lines;
}

const fmt = (n) => String(Math.round(n * 100) / 100);

function pdfString(codes) {
  let s = '';
  for (const c of codes) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) s += '\\' + String.fromCharCode(c);
    else if (c < 32 || c > 126) s += '\\' + c.toString(8).padStart(3, '0');
    else s += String.fromCharCode(c);
  }
  return `(${s})`;
}

function textOps(glyphs, size, x, y, tw = 0) {
  let ops = `BT\n${fmt(tw)} Tw\n1 0 0 1 ${fmt(x)} ${fmt(y)} Tm\n`;
  let font = null;
  let codes = [];
  for (const g of glyphs) {
    if (g.font !== font) {
      if (codes.length) ops += `${pdfString(codes)} Tj\n`;
      codes = [];
      font = g.font;
      ops += `/${font} ${size} Tf\n`;
    }
    codes.push(g.code);
  }
  if (codes.length) ops += `${pdfString(codes)} Tj\n`;
  return ops + 'ET\n';
}

function lineGlyphs(words) {
  const glyphs = [];
  words.forEach((wd, i) => {
    if (i) {
      const prev = glyphs[glyphs.length - 1].font;
      glyphs.push({ font: prev === 'F4' ? 'F1' : prev, code: 32, w: SPACE_W });
    }
    glyphs.push(...wd.glyphs);
  });
  return glyphs;
}

function lineOps(line, para, x, y, width) {
  const glyphs = lineGlyphs(line.words);
  const availPt = width - line.offset;
  const natPt = (line.w * para.size) / 1000;
  const spaces = glyphs.filter((g) => g.code === 32).length;
  let tw = 0;
  let dx = 0;
  const forced = line.end === '\n' || line.end === '\f';
  if (para.align === 'justify' && spaces && (line.end === null || (forced && line.fill > 0.8))) {
    tw = (availPt - natPt) / spaces;
  }
  if (para.align === 'center') dx = (availPt - natPt) / 2;
  if (para.align === 'right') dx = availPt - natPt;
  return textOps(glyphs, para.size, x + line.offset + dx, y, tw);
}

const rule = (x1, x2, y, w = 0.5) => `${w} w\n${fmt(x1)} ${fmt(y)} m ${fmt(x2)} ${fmt(y)} l S\n`;

// ---------------------------------------------------------------------------
// Flow: paragraphs poured line by line through a list of frames (columns).
// ---------------------------------------------------------------------------

class Flow {
  constructor(frames, pages) {
    this.frames = frames;
    this.pages = pages; // page index -> array of op strings (shared)
    this.fi = 0;
    this.y = frames[0].top;
    this.atTop = true;
    this.diag = [];
  }

  get frame() { return this.frames[this.fi]; }

  space(h) { if (!this.atTop) this.y -= h; }

  fits(h) { return this.y - h >= this.frame.bottom - 0.01; }

  next() {
    this.fi += 1;
    if (this.fi >= this.frames.length) {
      // Out of columns: keep going in a page-less frame so tune() can still
      // measure, and report the overflow.
      this.overflow = true;
      this.frames.push({ ...this.frames[this.fi - 1], page: null, top: 1e6, bottom: -1e6 });
    }
    this.y = this.frame.top;
    this.atTop = true;
  }

  emit(s) { if (this.frame.page != null) this.pages[this.frame.page].push(s); }

  para(p) {
    if (p.table) return this.table(p);
    this.space(p.before || 0);
    if (p.keep && !this.fits(p.leading * (1 + p.keep))) this.next();
    for (const line of breakLines(p, this.frame.w)) {
      if (!this.fits(p.leading)) this.next();
      this.y -= p.leading;
      this.atTop = false;
      this.emit(lineOps(line, p, this.frame.x, this.y, this.frame.w));
      if (line.end === '\n' || line.end === '\f') this.diag.push({ id: p.id, end: line.end, fill: line.fill });
      if (line.end === '\f') {
        this.diag.at(-1).lastInFrame = !this.fits(p.leading);
        this.next();
      }
    }
    this.space(p.after || 0);
  }

  // Station table. pdf.js merges same-font text on one line into a single item
  // even across wide gaps, and the app places a highlight proportionally within
  // its item, so a coordinate cell merged with its neighbours gets a smeared
  // highlight. Writing each row's coordinate cell last, after jumping back left
  // from the elevation column, makes pdf.js start a fresh item for it.
  table(t) {
    const rows = [t.head, ...t.rows];
    const need = rows.length * t.leading + 8;
    this.space(t.before || 0);
    if (!this.fits(need)) this.next();
    const { x, w } = this.frame;
    const top = this.y;
    const baseline = (ri) => top - (ri + 1) * t.leading;
    this.emit(rule(x, x + w, top, 0.8));
    this.emit(rule(x, x + w, baseline(0) - 3.5, 0.4));
    const order = [...t.cols.map((_, ci) => ci).filter((ci) => ci !== t.coordCol), t.coordCol];
    rows.forEach((row, ri) => {
      for (const ci of order) {
        const glyphs = lineGlyphs(tokenize(row[ci].replace(/ /g, '~'), ri === 0 ? 'B' : 'R'));
        const last = ci === t.cols.length - 1;
        const cx = last ? x + w - (glyphs.reduce((a, g) => a + g.w, 0) * t.size) / 1000 : x + t.cols[ci];
        this.emit(textOps(glyphs, t.size, cx, baseline(ri)));
      }
    });
    this.y = baseline(rows.length - 1) - 4;
    this.emit(rule(x, x + w, this.y, 0.8));
    this.atTop = false;
    this.space(t.after || 0);
  }
}

// ---------------------------------------------------------------------------
// Placeholder prose. Deterministic: the same seed always gives the same words.
// ---------------------------------------------------------------------------

const POOL = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed eiusmod tempor incididunt labore ' +
  'dolore magna aliqua enim minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ' +
  'commodo consequat duis aute irure reprehenderit voluptate velit esse cillum fugiat nulla ' +
  'pariatur excepteur sint occaecat cupidatat proident sunt culpa officia deserunt mollit anim ' +
  'laborum perspiciatis unde omnis iste natus error voluptatem accusantium doloremque laudantium ' +
  'totam aperiam eaque ipsa quae illo inventore veritatis quasi architecto beatae vitae dicta ' +
  'explicabo nemo ipsam quia voluptas aspernatur odit fugit consequuntur magni dolores ratione ' +
  'sequi nesciunt neque porro quisquam dolorem adipisci numquam eius modi tempora incidunt ' +
  'magnam quaerat'
).split(' ');

// n words of lorem. cap: capitalise the first word; end: finish with a period
// (otherwise the text runs straight on into whatever follows).
function L(n, seed, { cap = true, end = true } = {}) {
  let s = (seed * 2654435761) >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const words = [];
  let sentence = 0;
  let sentenceLen = 7 + Math.floor(rnd() * 9);
  for (let i = 0; i < n; i++) {
    let w = POOL[Math.floor(rnd() * POOL.length)];
    if (sentence === 0 && (i > 0 || cap)) w = w[0].toUpperCase() + w.slice(1);
    sentence += 1;
    const last = i === n - 1;
    if (sentence >= sentenceLen && !last) {
      w += '.';
      sentence = 0;
      sentenceLen = 7 + Math.floor(rnd() * 9);
    } else if (!last && sentence > 2 && rnd() < 0.1) {
      w += ',';
    }
    words.push(w);
  }
  return words.join(' ') + (end ? '.' : '');
}
const l = (n, seed) => L(n, seed, { cap: false, end: false });

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const BODY = { size: 9.5, leading: 11.6, align: 'justify', indent: 10 };
const FIRST = { ...BODY, indent: 0 };
const H1 = { size: 10, leading: 13, style: 'B', align: 'left', before: 9, after: 2, keep: 2 };
const H2 = { size: 9.5, leading: 12.5, style: 'I', align: 'left', before: 6, after: 1, keep: 2 };
const REF = { size: 7.8, leading: 9.4, align: 'justify', hang: 10, after: 1.5 };

// k: knobs found by tune() — filler lengths that make forced breaks land on
// full lines and the page-1 column end exactly where the split pair needs it.
function content(k) {
  const front = [
    { size: 18, leading: 21, style: 'B', align: 'left',
      text: 'Lorem ipsum dolor sit amet: a placeholder gazetteer of coordinate formats from Andean cloud forests' },
    { size: 10.5, leading: 14, align: 'left', before: 8,
      text: 'Lorem I. Dolor¹, Amet S. Consectetur² & Elit A. Adipiscing¹' },
    { size: 8, leading: 10, style: 'I', align: 'left', before: 4,
      text: '¹ Facultas Lorem Ipsum, Universitas Dolor, Quito, Ecuador. ² Institutum Consectetur, Eiusmod, Peru.' },
    { size: 8, leading: 10, align: 'left', before: 3,
      text: 'Received 14 March 2026 · Accepted 2 August 2026 · Published 30 September 2026 · Academic editor: S. Amet' },
  ];

  const abstract = [
    { size: 10, leading: 12, style: 'B', align: 'left', text: 'Abstract' },
    { size: 9, leading: 11, align: 'justify', before: 2,
      text: `${L(34, 1)} Two localities, Lat. 0.7426 S, Long. 77.7372 W and 0.4651° N, 77.8912° W, ` +
        `${l(18, 2)}. ${L(46, 3)}` },
    { size: 8.5, leading: 11, align: 'left', before: 5,
      text: '^Keywords:^ lorem, ipsum, dolor sit amet, coordinates, gazetteer, Ecuador, Neotropical region' },
  ];

  const body = [
    { ...H1, before: 0, text: '1. Introduction' },
    { ...FIRST,
      text: `${L(30, 5)} The type series was taken near Quito at 0°13'07"S, 78°30'35"W in 1898, ` +
        `${l(20, 6)}. ${L(26, 7)}` },
    { ...BODY,
      text: `${L(18, 8)} Bogotá (4°36′35″N 74°04′54″W), Lima (12°02’36”S, 77°01’42”W) and Cusco ` +
        `(13°31\`S, 71°58´W) ${l(16, 9)}. ${L(22, 10)}` },
    { ...BODY,
      text: `${L(16, 11)} At least 14 specimens from Guayaquil are labelled 2o10'S, 79o53'W, ${l(16, 12)}. ` +
        `Rio de Janeiro material (22°54'11''S 43°12'34''W) ${l(18, 13)}, with the head rotated ` +
        `25–30 degrees. ${L(14, 14)}` },
    { ...BODY,
      text: `${L(20, 15)} One old label reads only 2°45′S ${l(22, 16)}. ${L(12, 17)} Puerto Ayora ` +
        `(–90.3134, –0.7393) ${l(10, 18)}, and the Mitad del Mundo monument ` +
        `(S0°00'08" W078°27'21") ${l(12, 19)}.` },

    { ...H1, text: '2. Material and methods' },
    { ...FIRST, text: `${L(k.methods, 20)} Specimens were taken between 1200 and 2800 m, ${l(10, 21)}.` },
    { ...BODY, id: 'wrap',
      text: `${L(k.wrapA, 22, { end: false })} at Oyacachi, 0°13′S,\n78°03′W, ${l(k.wrapB, 23)}. Material from Archidona ` +
        `(0°54′S, 77°\n48′29″W) ${l(14, 24)}.` },
    { ...BODY,
      text: `${L(12, 25)} For comparison we examined loans from Costa Rica (9°44.287 N 83°46.875 W), ` +
        `a Mexican series labelled 100 ft., 17' N 104°46' W, and outgroups from Buenos Aires ` +
        `(34°36' S, 58°22' Oeste) and Cayenne (4°56' N, 52°20' Ouest). ${L(16, 26)}` },
    { ...BODY, id: 'page',
      text: `${L(k.page, 27)} The northernmost station lay near Mindo, 0°03′S,\f78°46′W, ${l(20, 28)}. ` +
        `${L(26, 29)}` },

    { ...H2, text: '2.1. Station data' },
    { ...FIRST, text: `${L(22, 30)} Table 1 lists every station exactly as written on its labels; ${l(14, 31)}.` },
    { size: 7.8, leading: 9.4, align: 'left', before: 6, keep: 6,
      text: '^Table 1.^ Sampling stations, coordinates transcribed verbatim (typographic quirks included).' },
    { table: true, size: 7.6, leading: 10.2, before: 3, after: 6, cols: [0, 16, 74, null], coordCol: 2, // last column is right-aligned
      head: ['St.', 'Locality', 'Coordinates (verbatim)', 'Elev.'],
      rows: [
        ['1', 'Yasuní', '0°40′27″S 76°23′52″W', '230 m'],
        ['2', 'Baños', '1˚24\'S 78˚25\'W', '1820 m'],
        ['3', 'Puyo', '1Deg 29\'S 78Deg 00\'W', '950 m'],
        ['4', 'Loja', '3°59\'S 79°12\'O', '2060 m'],
        ['5', 'Papallacta', '0º22\' South, 78º08\' West', '3300 m'],
        ['6', 'Tena', '0°59\'11\'S 77°48\'50\'W', '510 m'],
        ['7', 'Zamora', '4 04 03 S 78 57 22 W', '970 m'],
        ['8', 'Cuyabeno', '0°15\'03" S / 76°10\'40" W', '220 m'],
        ['9', 'Santa Cruz', '0°41.25\'S, 90°19.50\'W', '180 m'],
        ['10', 'Cuenca', '2°53\'49,6"S 79°00\'15,2"W', '2560 m'],
        ['11', 'Gualaquiza', '3.4011 S, 78.5764 W', '860 m'],
      ] },

    { ...H1, text: '3. Results' },
    { ...FIRST, text: `${L(30, 32)} _Loremia ipsumensis_ sp. n. ${l(24, 33)}. ${L(20, 34)}` },
    { ...BODY, text: `${L(26, 35)} _Dolorella sitamet_ (Consectetur, 1911) ${l(12, 36)}, including a female from Macas (−2.3087, −78.1184).` },
    { ...BODY, text: `${L(32, 38)} _Adipiscia elitoides_ comb. n. ${l(18, 39)}. ${L(k.results, 40)}` },

    { ...H1, text: '4. Discussion' },
    { ...FIRST, text: `${L(36, 41)} ${L(26, 42)}` },
    { ...BODY, text: `${L(30, 43)} (Fig. 1) ${l(24, 44)}. ${L(k.discussion, 45)}` },

    { ...H1, text: 'Acknowledgements' },
    { ...FIRST, size: 8.5, leading: 10.4, text: `${L(30, 46)}` },

    { ...H1, text: 'References' },
    { ...REF, text: 'Adipiscing, E.A. (2019) Lorem ipsum dolor sit amet in montane forests. _Acta Loremica_ 48: 211–238.' },
    { ...REF, text: 'Consectetur, A.S. (1911) Novae species dolorum ex Aequatoria. _Annales Ipsum_ 7: 45–67.' },
    { ...REF, text: 'Dolor, L.I. & Amet, S. (2004) Sed do eiusmod tempor: a revision. _Systematica Dolorum_ 3: 1–120.' },
    { ...REF, text: 'Elit, A. (2022) Consequat duis aute irure dolor. Universitas Dolor, Quito, 312 pp.' },
  ];

  const caption = {
    size: 7.8, leading: 9.4, align: 'justify',
    text: '^Figure 1.^ Distribution of _Dynastes hercules_, _Megasoma actaeon_, _Stomion helopoides_ and ' +
      '_S. laevigatum_ in Ecuador; Galápagos in the inset. Map drawn with PyMappr.',
  };

  return { front, abstract, body, caption };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function jpegSize(buf) {
  for (let i = 2; i < buf.length;) {
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error('no SOF marker in figure JPEG');
}

function layout(k, img) {
  const c = content(k);
  const pages = [[], []];
  const bg = [[], []];
  const center = (s, size, y, page) =>
    pages[page].push(lineOps(breakLines({ text: s, size, align: 'center' }, FULL_W)[0],
      { size, align: 'center' }, MARGIN, y, FULL_W));

  // Page 1 masthead goes first in the stream; page 2's running head goes last
  // so it never sits between the halves of the pair split across the pages.
  pages[0].push(textOps(lineGlyphs(tokenize('Journal of Placeholder Entomology 14(3): 201–202 (2026)', 'I')), 8, MARGIN, 748));
  const tag = lineGlyphs(tokenize('Research article', 'B'));
  pages[0].push(textOps(tag, 8, PAGE_W - MARGIN - (tag.reduce((a, g) => a + g.w, 0) * 8) / 1000, 748));
  pages[0].push(rule(MARGIN, PAGE_W - MARGIN, 742, 0.8));
  center('201', 8.5, 36, 0);

  const front = new Flow([{ page: 0, x: MARGIN, w: FULL_W, top: TOP - 4, bottom: 0 }], pages);
  c.front.forEach((p) => front.para(p));

  const PAD = 8;
  const absTop = front.y - 12;
  const abs = new Flow([{ page: 0, x: MARGIN + PAD, w: FULL_W - 2 * PAD, top: absTop - PAD + 2, bottom: 0 }], pages);
  c.abstract.forEach((p) => abs.para(p));
  const absBottom = abs.y - PAD;
  bg[0].push(`0.93 g\n${fmt(MARGIN)} ${fmt(absBottom)} ${fmt(FULL_W)} ${fmt(absTop - absBottom)} re f\n0 g\n`);

  // Figure 1 heads the right column of page 2, caption beneath it.
  const figW = COL_W;
  const figH = (COL_W * img.h) / img.w;
  const figY = TOP - figH;
  const capPages = [[], []];
  const cap = new Flow([{ page: 1, x: COL_X[1], w: COL_W, top: figY - 4, bottom: 0 }], capPages);
  cap.para(c.caption);

  const colTop = absBottom - 14;
  const body = new Flow([
    { page: 0, x: COL_X[0], w: COL_W, top: colTop, bottom: BOTTOM },
    { page: 0, x: COL_X[1], w: COL_W, top: colTop, bottom: BOTTOM },
    { page: 1, x: COL_X[0], w: COL_W, top: TOP, bottom: BOTTOM },
    { page: 1, x: COL_X[1], w: COL_W, top: cap.y - 12, bottom: BOTTOM },
  ], pages);
  c.body.forEach((p) => body.para(p));

  pages[1].push(...capPages[1]);
  bg[1].push(`q\n${fmt(figW)} 0 0 ${fmt(figH)} ${fmt(COL_X[1])} ${fmt(figY)} cm\n/Im1 Do\nQ\n`);
  pages[1].push(textOps(lineGlyphs(tokenize('Dolor _et al._ · Coordinate formats from Andean cloud forests', 'R')), 8, MARGIN, 748));
  const jn = lineGlyphs(tokenize('Journal of Placeholder Entomology 14(3)', 'I'));
  pages[1].push(textOps(jn, 8, PAGE_W - MARGIN - (jn.reduce((a, g) => a + g.w, 0) * 8) / 1000, 748));
  pages[1].push(rule(MARGIN, PAGE_W - MARGIN, 742, 0.8));
  center('202', 8.5, 36, 1);

  const streams = pages.map((p, i) => bg[i].join('') + '0 G\n' + p.join(''));
  return { streams, diag: body.diag, overflow: !!body.overflow };
}

// Choose filler lengths so every forced break lands on a well-filled line, the
// page-1 columns end exactly on the first half of the split pair, and page 2
// ends near the foot of its right column.
function tune(img) {
  const linesFill = (p) => breakLines(p, COL_W).filter((ln) => ln.end === '\n' || ln.end === '\f');
  const good = (f) => f > 0.86 && f < 0.995;
  const base = { methods: 30, wrapA: 10, wrapB: 10, page: 10, results: 2, discussion: 2 };
  const para = (k, id) => content(k).body.find((p) => p.id === id);

  let best = null;
  for (let a = 4; a < 40 && !best; a++) {
    for (let b = 4; b < 24 && !best; b++) {
      if (linesFill(para({ ...base, wrapA: a, wrapB: b }, 'wrap')).every((ln) => good(ln.fill))) best = { wrapA: a, wrapB: b };
    }
  }
  if (!best) throw new Error('tune: no filler fills the wrapped-pair lines');
  Object.assign(base, best);

  let page = null;
  for (let n = 4; n < 60 && page == null; n++) {
    if (linesFill(para({ ...base, page: n }, 'page')).every((ln) => good(ln.fill))) page = n;
  }
  if (page == null) throw new Error('tune: no filler fills the page-break line');
  base.page = page;

  let methods = null;
  for (let n = 10; n < 160 && methods == null; n++) {
    const { diag } = layout({ ...base, methods: n }, img);
    if (diag.find((d) => d.end === '\f')?.lastInFrame) methods = n;
  }
  if (methods == null) throw new Error('tune: page 1 cannot end on the split pair');
  base.methods = methods;

  for (const key of ['discussion', 'results']) {
    let fit = null;
    for (let n = 2; n < 200; n++) {
      if (layout({ ...base, [key]: n }, img).overflow) break;
      fit = n; // keep the longest text that still fits
    }
    if (fit != null) base[key] = fit;
  }
  return base;
}

// ---------------------------------------------------------------------------
// PDF assembly
// ---------------------------------------------------------------------------

function buildPdf(streams, jpeg, img) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null);
  const pagesId = add(null);
  const enc = add('<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [129 /ring 141 /minus] >>');
  const fonts = ['Times-Roman', 'Times-Bold', 'Times-Italic'].map((f) =>
    add(`<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding ${enc} 0 R >>`));
  fonts.push(add('<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>'));
  const image = add([
    `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB ` +
      `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    jpeg,
    '\nendstream',
  ]);
  const res = `<< /Font << ${fonts.map((id, i) => `/F${i + 1} ${id} 0 R`).join(' ')} >> /XObject << /Im1 ${image} 0 R >> >>`;
  const kids = streams.map((s) => {
    const content = add(`<< /Length ${Buffer.byteLength(s, 'latin1')} >>\nstream\n${s}endstream`);
    return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources ${res} /Contents ${content} 0 R >>`);
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add('<< /Title (CoordRippr demo article) /Producer (CoordRippr tools/make-demo-pdf.mjs) >>');

  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let pos = parts[0].length;
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pos);
    const pieces = [`${i + 1} 0 obj\n`, ...(Array.isArray(body) ? body : [body]), '\nendobj\n'];
    for (const piece of pieces) {
      const b = Buffer.isBuffer(piece) ? piece : Buffer.from(piece, 'latin1');
      parts.push(b);
      pos += b.length;
    }
  });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

const jpeg = fs.readFileSync(FIGURE);
const img = jpegSize(jpeg);
const knobs = tune(img);
const { streams, overflow } = layout(knobs, img);
if (overflow) throw new Error('text overflows page 2; shorten the content');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buildPdf(streams, jpeg, img));
console.log(`wrote ${out}`, knobs);

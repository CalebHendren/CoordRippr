// Generates docs/demo-scanned.pdf: docs/demo.pdf as if it had been photocopied,
// run through a 2002 office flatbed at 200 dpi and saved as low-quality JPEG.
// Image only — no text layer — so it is what a scanned paper looks like to
// CoordRippr. Skew, spine shadow, toner speckle, soft focus and blocky JPEG are
// all seeded, so the output is the same on every run.
// Needs @napi-rs/canvas, which npm installs with pdfjs-dist.
// Run: node tools/make-scanned-pdf.mjs [in.pdf] [out.pdf]

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const src = process.argv[2] || path.join(root, 'docs', 'demo.pdf');
const out = process.argv[3] || path.join(root, 'docs', 'demo-scanned.pdf');

const require = createRequire(path.join(root, 'package.json'));
const { createCanvas } = require('@napi-rs/canvas');
const pdfjs = await import(pathToFileURL(path.join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href);

const DPI = 200;
const JPEG_QUALITY = 38;

let seed = 2002;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());

// Per page: skew in degrees, shift in pixels, which edge the book spine is on.
const PAGE_LOOK = [
  { skew: -0.7, dx: 14, dy: 22, spine: 'left' },
  { skew: 0.45, dx: -10, dy: 30, spine: 'right' },
];

async function renderPage(page) {
  const vp = page.getViewport({ scale: DPI / 72 });
  const canvas = createCanvas(Math.round(vp.width), Math.round(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

function scan(clean, look) {
  const { width: w, height: h } = clean;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  // The sheet sat crooked on the glass.
  ctx.translate(w / 2 + look.dx, h / 2 + look.dy);
  ctx.rotate((look.skew * Math.PI) / 180);
  ctx.drawImage(clean, -w / 2, -h / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const grey = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    grey[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  }

  // Soft focus: a 3x3 box blur.
  const soft = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let j = -1; j <= 1; j++) {
        const yy = y + j;
        if (yy < 0 || yy >= h) continue;
        for (let k = -1; k <= 1; k++) {
          const xx = x + k;
          if (xx < 0 || xx >= w) continue;
          s += grey[yy * w + xx];
          n++;
        }
      }
      soft[y * w + x] = s / n;
    }
  }

  // Low-frequency unevenness in the paper/toner, sampled on a coarse grid.
  const G = 64;
  const gw = Math.ceil(w / G) + 2;
  const gh = Math.ceil(h / G) + 2;
  const blotch = Float32Array.from({ length: gw * gh }, () => gauss() * 6);
  const blotchAt = (x, y) => {
    const fx = x / G;
    const fy = y / G;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const v = (i, j) => blotch[(y0 + j) * gw + (x0 + i)];
    return (v(0, 0) * (1 - tx) + v(1, 0) * tx) * (1 - ty) + (v(0, 1) * (1 - tx) + v(1, 1) * tx) * ty;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // Photocopier contrast: thin strokes fill in, the paper goes grey.
      let v = soft[i] / 255;
      v = v < 0.62 ? v * 0.55 : 0.34 + (v - 0.62) * 1.55;
      v = Math.min(1, Math.max(0, v)) * 226 + 8;
      // The gutter of a bound volume never lies flat: a shadow down the spine.
      const fromSpine = look.spine === 'left' ? x : w - 1 - x;
      v -= 150 * Math.exp(-fromSpine / 38) + 28 * Math.exp(-fromSpine / 260);
      // Lid not quite closed: the far edge picks up a grey band.
      v -= 60 * Math.exp(-(h - 1 - y) / 18);
      v += blotchAt(x, y) + gauss() * 7;
      grey[i] = v;
    }
  }

  // Toner specks and dust on the glass.
  const specks = 900 + Math.floor(rnd() * 400);
  for (let s = 0; s < specks; s++) {
    const cx = Math.floor(rnd() * w);
    const cy = Math.floor(rnd() * h);
    const r = rnd() < 0.92 ? 1 : 2 + Math.floor(rnd() * 2);
    const dark = 60 + rnd() * 120;
    for (let j = -r; j <= r; j++) {
      for (let k = -r; k <= r; k++) {
        const xx = cx + k;
        const yy = cy + j;
        if (xx >= 0 && xx < w && yy >= 0 && yy < h && j * j + k * k <= r * r) grey[yy * w + xx] -= dark;
      }
    }
  }
  // A hair caught under the lid.
  let hx = w * (0.2 + rnd() * 0.6);
  let hy = h * (0.15 + rnd() * 0.7);
  let ang = rnd() * Math.PI * 2;
  for (let t = 0; t < 260; t++) {
    ang += gauss() * 0.06;
    hx += Math.cos(ang);
    hy += Math.sin(ang);
    const xx = Math.round(hx);
    const yy = Math.round(hy);
    if (xx >= 0 && xx < w && yy >= 0 && yy < h) grey[yy * w + xx] -= 110;
  }

  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(255, grey[i]));
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
    px[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Image-only PDF: each page is one full-bleed JPEG and nothing else. The canvas
// only writes three-channel JPEGs, so the grey pixels go in as DeviceRGB.
function buildPdf(pages, ptW, ptH) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null);
  const pagesId = add(null);
  const kids = pages.map(({ jpeg, w, h }) => {
    const image = add([
      `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      jpeg,
      '\nendstream',
    ]);
    const ops = `q\n${ptW} 0 0 ${ptH} 0 0 cm\n/Im0 Do\nQ\n`;
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}endstream`);
    return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${ptW} ${ptH}] ` +
      `/Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add('<< /Title (CoordRippr demo article, scanned) /Producer (CoordRippr tools/make-scanned-pdf.mjs) >>');

  const parts = [Buffer.from('%PDF-1.3\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let pos = parts[0].length;
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pos);
    for (const piece of [`${i + 1} 0 obj\n`, ...(Array.isArray(body) ? body : [body]), '\nendobj\n']) {
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

const doc = await pdfjs.getDocument({
  data: new Uint8Array(fs.readFileSync(src)),
  standardFontDataUrl: path.join(root, 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep,
  isEvalSupported: false,
}).promise;

const pages = [];
let size = null;
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  size ??= page.getViewport({ scale: 1 });
  const scanned = scan(await renderPage(page), PAGE_LOOK[(p - 1) % PAGE_LOOK.length]);
  pages.push({ jpeg: await scanned.encode('jpeg', JPEG_QUALITY), w: scanned.width, h: scanned.height });
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buildPdf(pages, size.width, size.height));
console.log(`wrote ${out} (${pages.map((p) => `${p.w}x${p.h}`).join(', ')})`);

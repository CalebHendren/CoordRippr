// Builds the static browser version of CoordRippr into dist-web/ for GitHub
// Pages. The renderer is plain web tech; src/webshim.js swaps the Electron IPC
// bridge for browser APIs (File System Access, blob downloads, direct fetch).
//
// The app is emitted at the *site root* (dist-web/index.html IS the app) so the
// Pages URL loads it directly — no redirect stub, and nothing for Jekyll to
// turn into a README landing page. In the Electron layout the renderer lives in
// src/ and imports pdf.js as ../node_modules/…; here everything is one level
// shallower, so those two references are rewritten to ./node_modules/….
//
// Run: node tools/build-web.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist-web');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// Renderer sources, flattened to the site root.
fs.cpSync(path.join(root, 'src'), out, { recursive: true });

// The pdf.js runtime subset.
const pdfjsSrc = path.join(root, 'node_modules', 'pdfjs-dist');
const pdfjsOut = path.join(out, 'node_modules', 'pdfjs-dist');
fs.mkdirSync(path.join(pdfjsOut, 'build'), { recursive: true });
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  fs.copyFileSync(path.join(pdfjsSrc, 'build', f), path.join(pdfjsOut, 'build', f));
}
for (const dir of ['standard_fonts', 'cmaps']) {
  fs.cpSync(path.join(pdfjsSrc, dir), path.join(pdfjsOut, dir), { recursive: true });
}

// The OCR runtime subset (src/ocrengine.js): the tesseract.js loader and worker,
// the LSTM-only WebAssembly builds (the worker picks relaxed-SIMD, SIMD or
// plain), and the English model. All served from the site, nothing from a CDN.
const nm = (...p) => path.join(root, 'node_modules', ...p);
const nmOut = (...p) => path.join(out, 'node_modules', ...p);
const OCR_FILES = [
  ['tesseract.js', 'dist', 'tesseract.esm.min.js'],
  ['tesseract.js', 'dist', 'worker.min.js'],
  ['tesseract.js-core', 'tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core', 'tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core', 'tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'],
];
for (const f of OCR_FILES) {
  fs.mkdirSync(path.dirname(nmOut(...f)), { recursive: true });
  fs.copyFileSync(nm(...f), nmOut(...f));
}

// app.js and ocrengine.js sit one directory shallower than in the Electron
// layout, so their node_modules references (pdf.js, tesseract.js) move up a level.
for (const [file, marker] of [['app.js', '../node_modules/pdfjs-dist/'], ['ocrengine.js', '../node_modules/']]) {
  const p = path.join(out, file);
  const src = fs.readFileSync(p, 'utf8');
  if (!src.includes(marker)) {
    throw new Error(`expected ${marker} references in ${file} — update build-web.mjs`);
  }
  fs.writeFileSync(p, src.replaceAll('../node_modules/', './node_modules/'));
}

// Widen the CSP so the browser build can call LLM APIs / GitHub directly
// (the Electron build keeps the strict one — its requests go via main).
const indexPath = path.join(out, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
const cspBefore = "connect-src 'self' blob: data:";
if (!html.includes(cspBefore)) {
  throw new Error('CSP marker not found in index.html — update build-web.mjs');
}
html = html.replace(cspBefore, "connect-src 'self' blob: data: https:");
fs.writeFileSync(indexPath, html);

// Pages housekeeping: never let Jekyll touch the output.
fs.writeFileSync(path.join(out, '.nojekyll'), '');

console.log(`built ${out}`);

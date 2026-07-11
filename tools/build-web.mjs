// Builds the static browser version of CoordRippr into dist-web/ for GitHub
// Pages. The renderer is plain web tech; src/webshim.js swaps the Electron IPC
// bridge for browser APIs (File System Access, blob downloads, direct fetch).
// Run: node tools/build-web.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist-web');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// Renderer sources (same relative layout as the Electron app).
fs.cpSync(path.join(root, 'src'), path.join(out, 'src'), { recursive: true });

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

// Widen the CSP so the browser build can call LLM APIs / GitHub directly
// (the Electron build keeps the strict one — its requests go via main).
const indexPath = path.join(out, 'src', 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
const cspBefore = "connect-src 'self' blob: data:";
if (!html.includes(cspBefore)) {
  throw new Error('CSP marker not found in index.html — update build-web.mjs');
}
html = html.replace(cspBefore, "connect-src 'self' blob: data: https:");
fs.writeFileSync(indexPath, html);

// Root redirect + Pages housekeeping.
fs.writeFileSync(
  path.join(out, 'index.html'),
  `<!DOCTYPE html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=./src/index.html">
<title>CoordRippr</title>
<p><a href="./src/index.html">Open CoordRippr</a></p>
`
);
fs.writeFileSync(path.join(out, '.nojekyll'), '');

console.log(`built ${out}`);

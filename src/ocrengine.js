// OCR engine for scanned pages: renders a pdf.js page at OCR_SCALE and runs
// tesseract.js on it, fully offline. The worker script, the WebAssembly core
// and the English model all ship with the app under node_modules/ (the web
// build copies the same files), so nothing is fetched from a CDN. Browser-only;
// the pure half (word boxes -> text, misread repairs) is ocr.js.

import { OCR_DPI, OCR_SCALE, wordsFromOcr } from './ocr.js';

const MODULES = new URL('../node_modules/', import.meta.url);
const TESSERACT_JS = new URL('tesseract.js/dist/tesseract.esm.min.js', MODULES).href;
const WORKER_PATH = new URL('tesseract.js/dist/worker.min.js', MODULES).href;
// A directory: the worker picks the relaxed-SIMD, SIMD or plain LSTM build the
// machine supports (each embeds its .wasm, so none is fetched separately).
const CORE_PATH = new URL('tesseract.js-core/', MODULES).href.replace(/\/$/, '');
// tessdata "best_int": the model tesseract.js itself defaults to for LSTM.
const LANG_PATH = new URL('@tesseract.js-data/eng/4.0.0_best_int/', MODULES).href.replace(/\/$/, '');

let workerPromise = null;
let onLog = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { default: Tesseract } = await import(TESSERACT_JS);
      const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
        workerPath: WORKER_PATH,
        corePath: CORE_PATH,
        langPath: LANG_PATH,
        // A blob: worker cannot importScripts a file:// URL in Electron.
        workerBlobURL: false,
        gzip: true,
        // The model ships with the app; a cached copy in IndexedDB would only
        // duplicate it.
        cacheMethod: 'none',
        logger: (m) => { if (onLog) onLog(m); },
      });
      await worker.setParameters({
        // Full page layout analysis (tesseract.js defaults to one text block,
        // which reads straight across both columns of a journal page).
        tessedit_pageseg_mode: Tesseract.PSM.AUTO,
        // The render resolution, so Tesseract does not have to guess it.
        user_defined_dpi: String(OCR_DPI),
      });
      return worker;
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

/**
 * OCR one page. Returns the compact word list ocr.js builds (PDF user space).
 * `progress(fraction)` reports recognition progress within the page.
 */
export async function ocrPage(pageProxy, progress = null) {
  const worker = await getWorker();
  const vp1 = pageProxy.getViewport({ scale: 1 });
  const vp = pageProxy.getViewport({ scale: OCR_SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pageProxy.render({ canvasContext: ctx, viewport: vp }).promise;

  onLog = progress
    ? (m) => { if (m.status === 'recognizing text') progress(m.progress || 0); }
    : null;
  try {
    // rotateAuto straightens a crooked scan first; without it Tesseract reads
    // across both columns of a skewed two-column page as one line.
    const { data } = await worker.recognize(canvas, { rotateAuto: true }, { blocks: true, text: false });
    return wordsFromOcr(data, {
      scale: OCR_SCALE, pageW: vp1.width, pageH: vp1.height, angle: data.rotateRadians || 0,
    });
  } finally {
    onLog = null;
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Shut the worker down (frees ~100 MB); the next ocrPage starts a new one. */
export async function stopOcrEngine() {
  const p = workerPromise;
  workerPromise = null;
  if (!p) return;
  try { await (await p).terminate(); } catch { /* never started */ }
}

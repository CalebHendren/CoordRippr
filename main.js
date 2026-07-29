// CoordRippr Electron main process (`npm start`). Prereq: `npm install` — needs
// network to download Electron. Renderer/UI code lives in src/.
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_FILES = 500;
const MAX_DEPTH = 4;

// ---------------------------------------------------------------------------
// Data folder
//
// Projects live in plain files, not in the renderer's IndexedDB: a file:// page's
// browser storage lives inside the Chromium profile and does not reliably
// survive reinstalling the app over itself, which is how sessions were being
// lost on update. Files also mean the user can back the folder up or sync it.
//
// `location.json` always sits in userData and is the only thing that knows where
// the data folder actually is, so a custom location survives an update too.
// ---------------------------------------------------------------------------

let dataDir = null;

function locationFile() {
  return path.join(app.getPath('userData'), 'location.json');
}

async function getDataDir() {
  if (dataDir) return dataDir;
  let chosen = null;
  try {
    const raw = await fs.readFile(locationFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.dir === 'string') chosen = parsed.dir;
  } catch {
    // No pointer yet (first run) or it is unreadable: fall back to userData.
  }
  dataDir = chosen || path.join(app.getPath('userData'), 'data');
  await fs.mkdir(dataDir, { recursive: true });
  return dataDir;
}

/**
 * Resolve a store-relative path, refusing anything that escapes the data folder.
 * The renderer is trusted-ish, but these paths are built from project and file
 * ids that ultimately came out of an imported file, so they get checked.
 */
async function storePath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('Invalid store path');
  const root = await getDataDir();
  const full = path.resolve(root, rel);
  const within = full === root || full.startsWith(root + path.sep);
  if (!within) throw new Error('Store paths may not leave the data folder');
  return full;
}

/**
 * Write via a temp file in the same directory, then rename over the target, so
 * a crash mid-write cannot leave a half-written snapshot where a whole one was.
 */
async function writeAtomic(full, data) {
  await fs.mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, full);
}

async function listPdfs(dir, depth = 0, out = []) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const e of entries) {
    if (out.length >= MAX_FILES) break;
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await listPdfs(full, depth + 1, out);
    else if (e.isFile() && /\.pdf$/i.test(e.name)) out.push(full);
  }
  return out;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 980,
    minHeight: 620,
    title: 'CoordRippr',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Headless test hooks (used by CI / development smoke tests only).
  win.webContents.on('did-finish-load', () => {
    const autoload = process.env.COORDRIPPR_AUTOLOAD;
    if (autoload) {
      win.webContents.send('autoload', autoload.split(path.delimiter).filter(Boolean));
    }
    const shot = process.env.COORDRIPPR_SHOT;
    if (shot) {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          await fs.writeFile(shot, img.toPNG());
        } finally {
          app.quit();
        }
      }, Number(process.env.COORDRIPPR_SHOT_DELAY || 6000));
    }
  });
  return win;
}

ipcMain.handle('choose-folder', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (res.canceled || res.filePaths.length === 0) return null;
  const folder = res.filePaths[0];
  const files = await listPdfs(folder);
  return { folder, files };
});

ipcMain.handle('choose-pdfs', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
  });
  if (res.canceled) return null;
  return { folder: null, files: res.filePaths };
});

ipcMain.handle('read-file', async (_e, filePath) => {
  if (typeof filePath !== 'string' || !/\.pdf$/i.test(filePath)) {
    throw new Error('Only PDF files can be read');
  }
  const buf = await fs.readFile(filePath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle('save-csv', async (_e, { defaultName, content }) => {
  const res = await dialog.showSaveDialog({
    defaultPath: defaultName || 'coordinates.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (res.canceled || !res.filePath) return null;
  // BOM so Excel opens UTF-8 (degree symbols) correctly.
  await fs.writeFile(res.filePath, '\uFEFF' + content, 'utf8');
  return res.filePath;
});

// Binary PDF save (used for the highlighted-PDF export).
ipcMain.handle('save-pdf', async (_e, { defaultName, data }) => {
  const res = await dialog.showSaveDialog({
    defaultPath: defaultName || 'highlighted.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, Buffer.from(data));
  return res.filePath;
});

// Generic HTTPS fetch proxied through the main process: used for LLM API
// calls (avoids renderer CORS restrictions) and the GitHub release check.
ipcMain.handle('net-fetch', async (_e, { url, method = 'GET', headers = {}, body = null }) => {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
    throw new Error('Only https:// URLs are allowed');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300000);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'user-agent': `CoordRippr/${app.getVersion()}`, ...headers },
      body: body ?? undefined,
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (err) {
    return { ok: false, status: 0, text: '', error: err && err.message ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
});

ipcMain.handle('open-external', (_e, url) => {
  if (typeof url === 'string' && /^https:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.handle('get-version', () => app.getVersion());

// ---------------------------------------------------------------------------
// Project store (see the data-folder notes at the top)
// ---------------------------------------------------------------------------

ipcMain.handle('store-read', async (_e, rel) => {
  try {
    return await fs.readFile(await storePath(rel), 'utf8');
  } catch {
    return null; // absent is normal: a fresh project has no snapshot yet
  }
});

ipcMain.handle('store-write', async (_e, { rel, text }) => {
  await writeAtomic(await storePath(rel), text);
});

ipcMain.handle('store-read-bin', async (_e, rel) => {
  try {
    const buf = await fs.readFile(await storePath(rel));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch {
    return null;
  }
});

ipcMain.handle('store-write-bin', async (_e, { rel, data }) => {
  await writeAtomic(await storePath(rel), Buffer.from(data));
});

ipcMain.handle('store-remove', async (_e, rel) => {
  await fs.rm(await storePath(rel), { recursive: true, force: true });
});

ipcMain.handle('store-dir', () => getDataDir());

// Move the whole store somewhere else (OneDrive, an external drive, …) and
// remember it. Existing contents come along; the old folder is left behind
// rather than deleted, so a failed move is never a lost project.
ipcMain.handle('store-set-dir', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Choose a folder for CoordRippr projects',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: await getDataDir(),
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const target = res.filePaths[0];
  const current = await getDataDir();
  if (path.resolve(target) === path.resolve(current)) return current;
  await fs.mkdir(target, { recursive: true });
  await fs.cp(current, target, { recursive: true, force: true });
  await fs.writeFile(locationFile(), JSON.stringify({ dir: target }), 'utf8');
  dataDir = target;
  return target;
});

// ---------------------------------------------------------------------------
// Project file export / import
// ---------------------------------------------------------------------------

ipcMain.handle('save-json', async (_e, { defaultName, content, extension = 'crproj', label = 'CoordRippr project' }) => {
  const res = await dialog.showSaveDialog({
    defaultPath: defaultName || `project.${extension}`,
    filters: [{ name: label, extensions: [extension] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, content, 'utf8');
  return res.filePath;
});

ipcMain.handle('open-json', async (_e, { extension = 'crproj', label = 'CoordRippr project' } = {}) => {
  const res = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: label, extensions: [extension] }],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return { path: res.filePaths[0], content: await fs.readFile(res.filePaths[0], 'utf8') };
});

// ---------------------------------------------------------------------------
// Renaming PDFs on disk (LLM-suggested names, reviewed by the user first)
// ---------------------------------------------------------------------------

/**
 * @param {Array}   items      [{path, newName}] — newName includes ".pdf"
 * @param {boolean} inPlace    rename the originals instead of copying
 * @param {string}  subfolder  where copies go, relative to each PDF's folder
 * @returns {Array} one {path, newName, ok, to?, error?} per item
 */
ipcMain.handle('rename-pdfs', async (_e, { items, inPlace = false, subfolder = 'renamed' }) => {
  const out = [];
  // The renderer sanitises this too, but main does not take its word for it:
  // a subfolder must be a single plain directory name, never a path.
  const folder = typeof subfolder === 'string' && subfolder === path.basename(subfolder)
    && subfolder !== '.' && subfolder !== '..' && subfolder.trim()
    ? subfolder
    : 'renamed';
  for (const item of Array.isArray(items) ? items : []) {
    const src = item && item.path;
    const name = item && item.newName;
    // Only ever a bare file name: no directory component can sneak in here.
    if (typeof src !== 'string' || typeof name !== 'string' || name !== path.basename(name) || !/\.pdf$/i.test(name)) {
      out.push({ ...item, ok: false, error: 'Invalid file name' });
      continue;
    }
    const dir = inPlace ? path.dirname(src) : path.join(path.dirname(src), folder);
    const dest = path.join(dir, name);
    try {
      if (path.resolve(dest) === path.resolve(src)) {
        out.push({ ...item, ok: true, to: dest, unchanged: true });
        continue;
      }
      await fs.mkdir(dir, { recursive: true });
      if (inPlace) {
        // rename() overwrites silently on POSIX, so check first — a rename must
        // never destroy a PDF that is already sitting at the target name.
        const clash = await fs.access(dest).then(() => true, () => false);
        if (clash) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        await fs.rename(src, dest);
      } else {
        await fs.copyFile(src, dest, fsConstants.COPYFILE_EXCL);
      }
      out.push({ ...item, ok: true, to: dest });
    } catch (err) {
      const msg = err && err.code === 'EEXIST'
        ? 'A file with that name already exists'
        : (err && err.message) || String(err);
      out.push({ ...item, ok: false, error: msg });
    }
  }
  return out;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

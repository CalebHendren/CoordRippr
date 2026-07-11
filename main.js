import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_FILES = 500;
const MAX_DEPTH = 4;

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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

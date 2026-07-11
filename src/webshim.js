// Browser adapter for the GitHub Pages build. Provides the same window.coordrippr
// API that the Electron preload exposes. Inside Electron the preload has already
// defined window.coordrippr, so this whole file is a no-op there.

if (!window.coordrippr) {
  const MAX_FILES = 500;

  async function walkDirectory(dirHandle, out, depth) {
    if (depth > 4 || out.length >= MAX_FILES) return;
    for await (const entry of dirHandle.values()) {
      if (out.length >= MAX_FILES) return;
      if (entry.name.startsWith('.')) continue;
      if (entry.kind === 'directory') {
        await walkDirectory(entry, out, depth + 1);
      } else if (/\.pdf$/i.test(entry.name)) {
        const file = await entry.getFile();
        out.push({ name: entry.name, path: null, data: await file.arrayBuffer() });
      }
    }
  }

  function inputPick({ directory = false } = {}) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = 'application/pdf,.pdf';
      if (directory) input.webkitdirectory = true;
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', async () => {
        const files = [...input.files].filter((f) => /\.pdf$/i.test(f.name)).slice(0, MAX_FILES);
        const specs = [];
        for (const f of files) {
          specs.push({ name: f.name, path: null, data: await f.arrayBuffer() });
        }
        input.remove();
        resolve({ folder: null, files: specs });
      });
      input.addEventListener('cancel', () => { input.remove(); resolve(null); });
      input.click();
    });
  }

  window.coordrippr = {
    platform: 'web',

    async chooseFolder() {
      if (window.showDirectoryPicker) {
        try {
          const dir = await window.showDirectoryPicker();
          const files = [];
          await walkDirectory(dir, files, 0);
          return { folder: dir.name, files };
        } catch (err) {
          if (err && err.name === 'AbortError') return null;
          throw err;
        }
      }
      return inputPick({ directory: true });
    },

    choosePdfs: () => inputPick({}),

    async readFile() {
      throw new Error('File paths are not available in the browser build');
    },

    async saveCsv({ defaultName, content }) {
      const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = defaultName || 'coordinates.csv';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
      return a.download;
    },

    async netFetch({ url, method = 'GET', headers = {}, body = null }) {
      if (!/^https:\/\//i.test(url)) throw new Error('Only https:// URLs are allowed');
      try {
        const res = await fetch(url, { method, headers, body: body ?? undefined });
        return { ok: res.ok, status: res.status, text: await res.text() };
      } catch (err) {
        return {
          ok: false, status: 0, text: '',
          error: `${err && err.message ? err.message : err} (this can be a CORS restriction — some providers only allow requests from apps, not browsers)`,
        };
      }
    },

    openExternal(url) {
      if (/^https:\/\//i.test(url)) window.open(url, '_blank', 'noopener');
    },

    getVersion: async () => null, // hides the update checker on web

    onAutoload() {},
  };
}

// Release checking helpers. Pure module (testable); the fetch happens via the
// platform layer (Electron main process, or browser fetch on the web build).

export const RELEASES_API =
  'https://api.github.com/repos/CalebHendren/CoordRippr/releases/latest';
export const RELEASES_PAGE =
  'https://github.com/CalebHendren/CoordRippr/releases/latest';
export const KOFI_URL = 'https://ko-fi.com/calebhendren';

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

/** "v1.2.3" / "1.2.3-beta" -> [1, 2, 3] (missing parts are 0). */
export function parseVersion(v) {
  const m = String(v || '').trim().match(/v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}

/** true when `remote` is strictly newer than `local`. */
export function isNewer(remote, local) {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  if (!r || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (r[i] > l[i]) return true;
    if (r[i] < l[i]) return false;
  }
  return false;
}

/** Is the daily check due? */
export function isDue(lastCheckTs, now = Date.now()) {
  const last = Number(lastCheckTs);
  if (!last || Number.isNaN(last)) return true;
  return now - last >= CHECK_INTERVAL_MS;
}

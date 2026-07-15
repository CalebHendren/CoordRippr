// electron-builder afterPack hook: ad-hoc code-sign the packaged macOS app.
//
// The CI build has no Developer ID certificate, so it ships unsigned. On Intel
// Macs an unsigned app still launches behind a Gatekeeper warning, but Apple
// Silicon refuses to run a binary that has no valid signature at all and
// reports the app as "damaged and can't be opened". Electron's own binaries
// arrive ad-hoc signed, but electron-builder rewrites them (rename, fuse
// flips) which invalidates that signature; with signing disabled it is never
// reapplied, so the arm64 build ends up with a broken signature.
//
// Re-signing ad-hoc here ("codesign -s -") gives every binary in the bundle a
// valid signature again, so the arm64 build opens with the same "unidentified
// developer" warning as the Intel build instead of the "damaged" error.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`afterPack: ad-hoc signed ${appPath}`);
};

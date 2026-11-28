// The helper a Dockerfile Kody writes carries to fetch the Firebase emulators from the cell's mirror.
//
// firebase-tools has no download-URL override (docs/runtime/egress-allowlist.md §17): it would reach
// storage.googleapis.com, which no machine of the cell may. It does skip a download when the file is already in its
// cache, so after the install this script puts each emulator there, from the mirror, under the name and in the place
// the installed firebase-tools itself says (its own getDownloadDetails: the same table in 13.x and 14.x, whatever the
// version, and the cache directory FIREBASE_EMULATORS_PATH or the default). It checks what it fetched the way
// firebase-tools does (size and md5) and the SHA-256 too where the version has one; any failure stops the build.
//
// It is written into the Dockerfile as one base64 line (a heredoc is refused in an authored Dockerfile, and a
// helper file may only be a Dockerfile or a compose file), run as `node <file> <emulator>...`.

export const FIREBASE_EMULATORS_FETCH_SCRIPT = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const cp = require('child_process');

const TAG = 'fetch-firebase-emulators: ';
const fail = (m) => {
  console.error(TAG + m);
  process.exit(1);
};
const names = process.argv.slice(2);
if (!names.length) fail('no emulator named');
const mirror = (process.env.FIREBASE_EMULATORS_MIRROR || '').replace(/\/+$/, '');
if (!mirror) {
  console.log(TAG + 'FIREBASE_EMULATORS_MIRROR is empty (the cell serves no mirror): firebase-tools downloads the emulators itself');
  process.exit(0);
}

function firebaseToolsRoot() {
  const where = [process.cwd()];
  try {
    where.push(cp.execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch (e) {}
  for (const dir of where) {
    try {
      return path.dirname(require.resolve('firebase-tools/package.json', { paths: [dir] }));
    } catch (e) {}
  }
  return fail('firebase-tools is not installed (looked in ' + where.join(' and ') + '); install it before this step');
}

function download(url, to) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https:') ? https.get : http.get;
    get(url, { headers: { 'Accept-Encoding': 'identity' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('GET ' + url + ' answered ' + res.statusCode));
      }
      const md5 = crypto.createHash('md5');
      const sha = crypto.createHash('sha256');
      let size = 0;
      const out = fs.createWriteStream(to);
      res.on('data', (d) => {
        size += d.length;
        md5.update(d);
        sha.update(d);
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('close', () => resolve({ size, md5: md5.digest('hex'), sha256: sha.digest('hex') }));
      res.pipe(out);
    }).on('error', (e) => reject(new Error('GET ' + url + ': ' + e.message)));
  });
}

async function fetchOne(root, details, name) {
  if (details.localOnly) return console.log(TAG + name + ' is given by its *_EMULATOR_BINARY_PATH; nothing to fetch');
  const o = details.opts;
  const file = path.basename(details.downloadPath);
  if (o.skipChecksumAndSize) fail(name + ' is an experiment snapshot (no checksum); not served by the mirror');
  if (!o.expectedChecksum && !o.expectedChecksumSHA256) fail(name + ': firebase-tools names no checksum for ' + file + ' (no checksum, no download)');
  const u = new URL(o.remoteUrl);
  const m = /^\/(firebase-preview-drop|firemat-preview-drop)\/emulator\/([A-Za-z0-9._-]+)$/.exec(u.pathname);
  if (u.hostname !== 'storage.googleapis.com' || !m) fail(name + ': firebase-tools downloads from ' + o.remoteUrl + ', which the mirror does not serve');
  // Data Connect is a second mirror entry beside the emulators'.
  const base = m[1] === 'firemat-preview-drop' ? mirror.replace(/\/firebase-emulators$/, '/firebase-dataconnect') : mirror;
  const url = base + '/' + m[1] + '/emulator/' + m[2];
  fs.mkdirSync(o.cacheDir, { recursive: true });
  const part = details.downloadPath + '.part';
  let got;
  try {
    got = await download(url, part);
    if (o.expectedSize !== undefined && got.size !== o.expectedSize) throw new Error(file + ': expected ' + o.expectedSize + ' bytes but got ' + got.size);
    if (o.expectedChecksum && got.md5 !== o.expectedChecksum) throw new Error(file + ': expected checksum ' + o.expectedChecksum + ' but got ' + got.md5);
    if (o.expectedChecksumSHA256 && got.sha256 !== o.expectedChecksumSHA256) throw new Error(file + ': expected checksum ' + o.expectedChecksumSHA256 + ' but got ' + got.sha256);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
  fs.renameSync(part, details.downloadPath);
  if (details.unzipDir) await require(path.join(root, 'lib', 'unzip.js')).unzip(details.downloadPath, details.unzipDir);
  fs.chmodSync(details.binaryPath || details.downloadPath, 0o755);
  console.log(TAG + name + ': ' + file + ' (' + got.size + ' bytes) checked and stored in ' + o.cacheDir);
}

(async () => {
  const root = firebaseToolsRoot();
  const emulators = require(path.join(root, 'lib', 'emulator', 'downloadableEmulators.js'));
  for (const name of names) {
    let details;
    try {
      details = emulators.getDownloadDetails(name);
    } catch (e) {
      fail(name + ' is not an emulator this firebase-tools downloads (' + e.message + ')');
    }
    await fetchOne(root, details, name);
  }
})().catch((e) => fail(e.message));
`;

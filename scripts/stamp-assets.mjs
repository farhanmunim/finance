#!/usr/bin/env node
/**
 * Cache-busting version stamps.
 *
 * Browsers and CDNs cache JavaScript, CSS and JSON for hours. Without versioning, a visitor can
 * load a freshly deployed HTML page that then runs an old cached script or old data and breaks.
 * This script gives every asset a content-hash version and rewrites every reference to it:
 *   - <script src="/assets/js/x.js?v=HASH"> and <link href="/assets/css/style.css?v=HASH"> in HTML
 *   - import ... from './x.js?v=HASH' inside the JS modules (a module's hash includes the hashes
 *     of the modules it imports, so a change deep in the graph re-versions everything above it)
 *   - DATA_VERSION in assets/js/ui.js, appended to every fetch of /data/tax-years/*.json
 *
 *   node scripts/stamp-assets.mjs           # rewrite stamps
 *   node scripts/stamp-assets.mjs --check   # exit 1 if any stamp is stale (used by CI and pretest)
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const CHECK = process.argv.includes('--check');
const root = resolve(new URL('..', import.meta.url).pathname);
const jsDir = resolve(root, 'assets/js');
const htmlFiles = ['index.html', 'income/index.html', 'mortgage/index.html', 'pension/index.html', '404.html'].map((f) => resolve(root, f));
const cssFile = resolve(root, 'assets/css/style.css');
const dataDir = resolve(root, 'data/tax-years');

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10);
const stripVersions = (s) => s.replace(/\?v=[0-9a-f]*/g, '').replace(/DATA_VERSION = '[0-9a-f]*'/, "DATA_VERSION = ''");

// 1. Data version: hash of all tax-year JSON files.
const dataFiles = readdirSync(dataDir).filter((f) => f.endsWith('.json')).sort();
const dataVersion = hash(dataFiles.map((f) => f + readFileSync(resolve(dataDir, f), 'utf8')).join('\n'));

// 2. JS modules: hash content (with versions stripped, data version applied) + imported modules' hashes.
const jsFiles = readdirSync(jsDir).filter((f) => f.endsWith('.js'));
const src = Object.fromEntries(jsFiles.map((f) => [f, readFileSync(resolve(jsDir, f), 'utf8')]));
const importsOf = (f) => [...stripVersions(src[f]).matchAll(/from\s+'\.\/([\w-]+\.js)'/g)].map((m) => m[1]);
const versions = {};
const versionOf = (f, seen = []) => {
  if (versions[f]) return versions[f];
  if (seen.includes(f)) throw new Error(`import cycle: ${[...seen, f].join(' -> ')}`);
  const deps = importsOf(f).map((d) => versionOf(d, [...seen, f]));
  let body = stripVersions(src[f]);
  if (f === 'ui.js') body = body.replace("DATA_VERSION = ''", `DATA_VERSION = '${dataVersion}'`);
  versions[f] = hash(body + '\n' + deps.join(','));
  return versions[f];
};
jsFiles.forEach((f) => versionOf(f));
const cssVersion = hash(readFileSync(cssFile, 'utf8'));

// 3. Rewrite references.
const changes = [];
const rewrite = (file, text, next) => { if (text !== next) { changes.push(basename(file)); if (!CHECK) writeFileSync(file, next); } };
for (const f of jsFiles) {
  let next = src[f].replace(/from\s+'\.\/([\w-]+\.js)(?:\?v=[0-9a-f]*)?'/g, (m, d) => `from './${d}?v=${versions[d]}'`);
  if (f === 'ui.js') next = next.replace(/DATA_VERSION = '[0-9a-f]*'/, `DATA_VERSION = '${dataVersion}'`);
  rewrite(resolve(jsDir, f), src[f], next);
}
for (const file of htmlFiles) {
  const text = readFileSync(file, 'utf8');
  let next = text.replace(/(src="\/assets\/js\/([\w-]+\.js))(\?v=[0-9a-f]*)?"/g, (m, pre, f) => `${pre}?v=${versions[f]}"`);
  next = next.replace(/(href="\/assets\/css\/style\.css)(\?v=[0-9a-f]*)?"/g, `$1?v=${cssVersion}"`);
  rewrite(file, text, next);
}

if (CHECK) {
  if (changes.length) { console.error(`Asset version stamps are stale in: ${changes.join(', ')}. Run: npm run stamp`); process.exit(1); }
  console.log('Asset version stamps are current.');
} else {
  console.log(changes.length ? `Stamped: ${changes.join(', ')}` : 'Nothing to change.');
  console.log(`data ${dataVersion} css ${cssVersion} ${jsFiles.map((f) => `${f} ${versions[f]}`).join(' ')}`);
}

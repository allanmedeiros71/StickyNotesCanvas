#!/usr/bin/env node
// Precompiled web build: writes a copy of the app to www/ (or the directory
// given as the first argument) that runs without Babel in the browser.
//
// The source index.html loads the four .jsx files as <script type="text/babel">
// and lets vendor/babel.min.js (3 MB) transpile them on every launch. That is
// fine on a desktop, but on a phone it is the slowest part of opening the app.
// This script does that work once, ahead of time:
//
//   - each .jsx file, in the order index.html loads them, is compiled by the
//     very same vendored Babel with the very same options it applies to a
//     <script type="text/babel"> in the browser, so the output behaves exactly
//     as it does today (the sources depend on that: every file redeclares
//     `const { useState, ... } = React`, which only works because Babel's env
//     preset turns it into `var`). The results are joined and minified with
//     esbuild into one classic script, app.bundle.js — not a module, so
//     top-level names stay globals shared between the files, as before;
//   - www/index.html is index.html with the Babel script dropped and the
//     text/babel tags replaced by capacitor-bridge.js + app.bundle.js (the
//     bridge does nothing unless the page runs inside the Android app);
//   - www/sw.js precaches those two instead of the .jsx files and Babel;
//   - everything else the page needs (vendor/, assets/, pwa/, manifest) is
//     copied as is.
//
// The source files are left alone: the desktop app and the GitHub Pages demo
// keep running straight from the repository root, as before. www/ is the
// directory a native wrapper (Capacitor) or any static host can serve.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || path.join(root, 'www'));
const BUNDLE = 'app.bundle.js';
const BRIDGE = 'capacitor-bridge.js';
const BABEL = 'vendor/babel.min.js';

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

export async function buildWeb(outDir = out) {
  const indexHtml = read('index.html');

  // The .jsx files and their order come from index.html, so adding a file
  // there is all it takes for the build to pick it up.
  const babelTag = /<script\s+type="text\/babel"\s+src="([^"]+)"\s*><\/script>\s*\n?/g;
  const sources = [...indexHtml.matchAll(babelTag)].map(m => m[1].replace(/^\.\//, ''));
  if (sources.length === 0) throw new Error('index.html loads no text/babel scripts');

  // The options @babel/standalone uses for a text/babel script with no
  // data-presets / data-plugins (see transformScriptTags in babel.min.js).
  const Babel = createRequire(import.meta.url)(path.join(root, BABEL));
  const compiled = sources.map(f => Babel.transform(read(f), {
    filename: f,
    presets: ['react', 'env'],
    plugins: ['transform-class-properties', 'transform-object-rest-spread', 'transform-flow-strip-types'],
  }).code);

  const joined = compiled.map((code, i) => `// ---- ${sources[i]} ----\n${code}\n`).join('\n');
  const result = await esbuild.transform(joined, {
    loader: 'js',
    target: 'es2020',          // only minifies here: Babel already lowered the syntax
    minify: true,              // top-level names are kept: this is a classic script, not a module
    sourcemap: 'external',
    sourcefile: 'app.jsx-sources.js',
    legalComments: 'none',
  });

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(path.join(outDir, BUNDLE),
    `${result.code}//# sourceMappingURL=${BUNDLE}.map\n`);
  fs.writeFileSync(path.join(outDir, `${BUNDLE}.map`), result.map);

  // index.html: no Babel, one compiled script where the text/babel ones were.
  let html = indexHtml.replace(
    new RegExp(`<script\\s+src="\\.?\\/?${BABEL.replace(/[.\/]/g, '\\$&')}"\\s*><\\/script>\\s*\\n?`), '');
  if (html === indexHtml) throw new Error(`index.html no longer loads ${BABEL}`);
  let first = true;
  html = html.replace(babelTag, () => {
    if (!first) return '';
    first = false;
    return `<script src="./${BRIDGE}"></script>\n<script src="./${BUNDLE}"></script>\n`;
  });
  fs.writeFileSync(path.join(outDir, 'index.html'), html);

  // sw.js: same worker, precache list adjusted to the compiled files.
  const sw = read('sw.js');
  const listRe = /const PRECACHE = \[([\s\S]*?)\];/;
  const m = listRe.exec(sw);
  if (!m) throw new Error('sw.js: PRECACHE list not found');
  const entries = [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1])
    .filter(p => !sources.includes(p) && p !== BABEL);
  const insertAt = entries.indexOf('index.html') + 1 || entries.length;
  entries.splice(insertAt, 0, BRIDGE, BUNDLE);
  fs.writeFileSync(path.join(outDir, 'sw.js'),
    sw.replace(listRe, `const PRECACHE = [\n${entries.map(e => `  '${e}',`).join('\n')}\n];`));

  // Static files, as is. Babel stays behind: nothing in www/ loads it.
  for (const rel of [BRIDGE, 'manifest.webmanifest', 'pwa', 'assets', 'vendor']) {
    fs.cpSync(path.join(root, rel), path.join(outDir, rel), {
      recursive: true,
      filter: (src) => path.relative(root, src) !== path.normalize(BABEL),
    });
  }

  // Every file the new page and worker need must be there.
  const refs = [
    ...[...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(x => x[1]),
    ...[...html.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map(x => x[1]),
  ].filter(r => !/^(?:[a-z]+:|\/\/|#)/i.test(r)).map(r => r.replace(/^\.\//, ''));
  const missing = [...new Set([...refs, ...entries.filter(e => e !== './')])]
    .filter(rel => !fs.existsSync(path.join(outDir, rel)));
  if (missing.length) throw new Error(`build-web: missing in output: ${missing.join(', ')}`);

  return { outDir, sources, bundleBytes: Buffer.byteLength(result.code), precache: entries };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t0 = Date.now();
  const r = await buildWeb();
  console.log(`build-web: ${r.sources.join(' + ')} -> ${path.relative(root, r.outDir) || '.'}/${BUNDLE}` +
    ` (${(r.bundleBytes / 1024).toFixed(0)} KB) in ${Date.now() - t0} ms`);
}

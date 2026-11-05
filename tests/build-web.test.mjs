import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildWeb } from '../build-web.mjs';

// build-web.mjs: the precompiled copy of the web app in www/ (no Babel in the
// browser). Built once into a temp dir; each test checks one promise the
// script makes.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let out, result;

before(async () => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-www-'));
  result = await buildWeb(out);
});

const read = (rel) => fs.readFileSync(path.join(out, rel), 'utf8');

test('compiles the same .jsx files index.html loads, in the same order', () => {
  const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const expected = [...src.matchAll(/type="text\/babel"\s+src="([^"]+)"/g)].map(m => m[1].replace(/^\.\//, ''));
  assert.deepEqual(result.sources, expected);
});

test('the built page loads no Babel and no .jsx, and loads the bundle once', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /babel\.min\.js/);
  assert.doesNotMatch(html, /text\/babel/);
  assert.doesNotMatch(html, /\.jsx"/);
  assert.equal(html.match(/src="\.\/app\.bundle\.js"/g)?.length, 1);
  assert.ok(!fs.existsSync(path.join(out, 'vendor', 'babel.min.js')), 'Babel is not copied');
});

test('the bundle comes after the vendor scripts it depends on', () => {
  const html = read('index.html');
  for (const v of ['react.production.min.js', 'react-dom.production.min.js', 'markdown-it.min.js', 'mermaid.min.js']) {
    assert.ok(html.indexOf(v) < html.indexOf('app.bundle.js'), `${v} loads before the bundle`);
  }
});

test('the bundle is valid JavaScript with no JSX left in it', () => {
  const code = read('app.bundle.js');
  assert.doesNotThrow(() => new vm.Script(code, { filename: 'app.bundle.js' }));
  assert.match(code, /React\.createElement/);
});

test('top-level names stay globals, as when each file is its own classic script', () => {
  // The files call each other through globals (components.jsx uses
  // utils.jsx's mdToHtml, app.jsx renders components.jsx's components), so
  // the minifier must not rename top-level declarations.
  const code = read('app.bundle.js');
  assert.match(code, /function mdToHtml\(/);
});

test('the built service worker precaches the bundle and only files that exist', () => {
  assert.ok(result.precache.includes('app.bundle.js'));
  assert.ok(!result.precache.some(p => p.endsWith('.jsx') || p.endsWith('babel.min.js')));
  for (const p of result.precache) {
    if (p === './') continue;
    assert.ok(fs.existsSync(path.join(out, p)), `precached ${p} exists`);
  }
  assert.match(read('sw.js'), /'app\.bundle\.js',/);
});

test('the source files are left untouched', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /vendor\/babel\.min\.js/);
  assert.match(html, /type="text\/babel"/);
});

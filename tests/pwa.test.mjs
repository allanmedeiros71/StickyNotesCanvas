import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// The web build as an installable app (#60): index.html links
// manifest.webmanifest and, on the web only, registers sw.js, which
// precaches the app so the installed window opens with no network.
//
// There is no build step to generate the precache list, so it is kept by
// hand — and these tests hold it to the page: a file index.html (or a .jsx
// file) loads that the list misses is a file the installed app can't find
// offline, and a listed file that doesn't exist makes the service worker
// fail to install at all.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const indexHtml = read('index.html');

// GitHub Pages serves the demo from a subpath; everything must resolve there.
const SITE = 'https://faridjaff.github.io/StickyNotesCanvas/';

function loadManifest() {
  return JSON.parse(read('manifest.webmanifest'));
}

// sw.js is a worker script, not a module: run it against a stub `self` and
// read PRECACHE back as the script's completion value.
function loadPrecache() {
  const sandbox = {
    self: { location: new URL('sw.js', SITE).href, addEventListener() {} },
    URL, console,
  };
  vm.createContext(sandbox);
  return vm.runInContext(read('sw.js') + '\n;PRECACHE', sandbox);
}

// Width and height from a PNG's IHDR chunk.
function pngSize(rel) {
  const buf = fs.readFileSync(path.join(root, rel));
  assert.equal(buf.toString('ascii', 1, 4), 'PNG', `${rel} is not a PNG`);
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

// Every same-site file index.html pulls in: src/href attributes and CSS url()s.
function filesIndexHtmlLoads() {
  const refs = [
    ...[...indexHtml.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(m => m[1]),
    ...[...indexHtml.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map(m => m[1]),
  ];
  return refs.filter(r => !/^(?:[a-z]+:|\/\/|#)/i.test(r)).map(r => r.replace(/^\.\//, ''));
}

/* ---------------- manifest ---------------- */

test('the manifest has what Chrome needs to offer "Install app"', () => {
  const m = loadManifest();
  assert.equal(m.name, 'Sticky Notes');
  assert.ok(m.short_name, 'short_name is what the launcher shows');
  assert.equal(m.display, 'standalone', 'opens in its own window, not a tab');
  assert.ok(m.start_url, 'start_url');
  assert.ok(Array.isArray(m.icons) && m.icons.length, 'icons');
});

test('start_url and scope are relative, so the app installs under the Pages subpath', () => {
  const m = loadManifest();
  const manifestUrl = new URL('manifest.webmanifest', SITE);
  for (const key of ['start_url', 'scope']) {
    assert.doesNotMatch(m[key], /^(?:[a-z]+:|\/)/i, `${key} must be relative, not ${m[key]}`);
    assert.equal(new URL(m[key], manifestUrl).href, SITE, `${key} resolves to the app`);
  }
});

test('icons exist at the sizes they claim: 192 and 512, plain and maskable', () => {
  const m = loadManifest();
  for (const icon of m.icons) {
    assert.equal(icon.type, 'image/png', icon.src);
    assert.equal(pngSize(icon.src), icon.sizes, `${icon.src} declares ${icon.sizes}`);
  }
  const have = (purpose) => m.icons.filter(i => (i.purpose || 'any') === purpose).map(i => i.sizes).sort();
  assert.deepEqual(have('any'), ['192x192', '512x512']);
  assert.deepEqual(have('maskable'), ['192x192', '512x512']);
});

test('window colours match the app: splash = page background, title bar = default theme top bar', () => {
  const m = loadManifest();
  const bodyBg = indexHtml.match(/html, body \{[^}]*background:(#[0-9a-f]{6})/i)[1];
  assert.equal(m.background_color, bodyBg);

  // themeTokens and TWEAK_DEFAULTS from utils.jsx, as tests/download.test.mjs loads it.
  const sandbox = { React: {}, window: {}, document: {}, navigator: {}, console, Math, JSON, Date };
  vm.createContext(sandbox);
  vm.runInContext(read('utils.jsx'), sandbox);
  const { themeTokens, TWEAK_DEFAULTS } = sandbox.window;
  const topBar = themeTokens(TWEAK_DEFAULTS.theme).panelBg;
  assert.equal(m.theme_color, topBar);
  assert.match(indexHtml, new RegExp(`<meta name="theme-color" content="${topBar}"`));
});

/* ---------------- registration ---------------- */

test('index.html links the manifest', () => {
  assert.match(indexHtml, /<link rel="manifest" href="\.\/manifest\.webmanifest">/);
});

// Run index.html's inline (non-babel) scripts with a stubbed browser and
// report what they asked navigator.serviceWorker to register.
function registrations({ protocol, stickyAPI, stickyNative }) {
  const registered = [];
  const onLoad = [];
  const window = { addEventListener: (type, fn) => { if (type === 'load') onLoad.push(fn); } };
  if (stickyAPI) window.stickyAPI = {};
  if (stickyNative) window.stickyNative = { platform: 'android' };
  const sandbox = {
    window, console,
    location: { protocol },
    navigator: { serviceWorker: { register: (url) => { registered.push(url); return Promise.resolve(); } } },
  };
  vm.createContext(sandbox);
  const inline = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(inline.length, 'index.html has an inline registration script');
  for (const code of inline) vm.runInContext(code, sandbox);
  onLoad.forEach(fn => fn());
  return registered;
}

test('the web build registers sw.js from its own directory', () => {
  assert.deepEqual(registrations({ protocol: 'https:' }), ['./sw.js']);
  assert.deepEqual(registrations({ protocol: 'http:' }), ['./sw.js'], 'localhost serving, for testing');
});

test('the desktop app never registers a service worker', () => {
  assert.deepEqual(registrations({ protocol: 'file:', stickyAPI: true }), []);
  // Either signal alone is enough — stickyAPI over some future app:// scheme…
  assert.deepEqual(registrations({ protocol: 'https:', stickyAPI: true }), []);
  // …or a file:// page without the bridge.
  assert.deepEqual(registrations({ protocol: 'file:' }), []);
});

test('the Android app never registers a service worker', () => {
  // Capacitor serves the page from https://localhost, which looks like the web.
  assert.deepEqual(registrations({ protocol: 'https:', stickyNative: true }), []);
});

/* ---------------- precache ---------------- */

test('every file index.html loads is precached for offline use', () => {
  const precache = loadPrecache();
  const files = filesIndexHtmlLoads();
  assert.ok(files.includes('app.jsx') && files.includes('vendor/babel.min.js'), 'the scan finds the scripts');
  assert.ok(files.includes('assets/fonts/inter-400.woff2'), 'the scan finds the fonts');
  for (const f of files) {
    assert.ok(precache.includes(f), `${f} is loaded by index.html but missing from PRECACHE in sw.js`);
  }
  assert.ok(precache.includes('./'), 'the start URL itself');
});

test('the manifest icons are precached, so the browser finds them offline too', () => {
  const precache = loadPrecache();
  for (const icon of loadManifest().icons) {
    assert.ok(precache.includes(icon.src), `${icon.src} is in the manifest but missing from PRECACHE in sw.js`);
  }
});

test('every asset a .jsx file references is precached', () => {
  const precache = loadPrecache();
  const jsx = fs.readdirSync(root).filter(f => f.endsWith('.jsx'));
  const refs = jsx.flatMap(f => [...read(f).matchAll(/["'`]\.?\/?(assets\/[^"'`\s]+)["'`]/g)].map(m => m[1]));
  assert.ok(refs.includes('assets/pin-filled.png'), 'the scan finds the pin icon');
  for (const r of refs) assert.ok(precache.includes(r), `${r} is used by the app but missing from PRECACHE in sw.js`);
});

test('every precached path exists — one bad entry stops the service worker installing', () => {
  for (const p of loadPrecache()) {
    assert.doesNotMatch(p, /^(?:[a-z]+:|\/)/i, `${p} must be relative to sw.js`);
    if (p === './') continue;
    assert.ok(fs.existsSync(path.join(root, p)), `${p} is in PRECACHE but not in the repo`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// capacitor-bridge.js (Android build): run it against a stub window with an
// in-memory Filesystem plugin standing in for the native one.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = fs.readFileSync(path.join(root, 'capacitor-bridge.js'), 'utf8');

function fakeFs() {
  const files = new Map();   // "DIR/path" -> string
  const key = (directory, p) => `${directory}/${p}`;
  const log = [];
  const notFound = () => Object.assign(new Error('File does not exist'), { code: 'OS-PLUG-FILE-0008' });
  return {
    files, log,
    Filesystem: {
      async readFile({ path: p, directory }) { if (!files.has(key(directory, p))) throw notFound(); return { data: files.get(key(directory, p)) }; },
      async writeFile({ path: p, directory, data }) { log.push(`write ${p}`); files.set(key(directory, p), data); return {}; },
      async stat({ path: p, directory }) { if (!files.has(key(directory, p))) throw notFound(); return {}; },
      async deleteFile({ path: p, directory }) { if (!files.delete(key(directory, p))) throw notFound(); log.push(`delete ${p}`); },
      async rename({ from, to, directory, toDirectory }) {
        if (!files.has(key(directory, from))) throw notFound();
        // Like the native plugin, refuse to rename over an existing file —
        // the bridge must delete first.
        if (files.has(key(toDirectory, to))) throw new Error('destination exists');
        files.set(key(toDirectory, to), files.get(key(directory, from)));
        files.delete(key(directory, from));
        log.push(`rename ${from} ${to}`);
      },
      async getUri({ path: p, directory }) { return { uri: `file:///${directory.toLowerCase()}/${p}` }; },
    },
  };
}

function run({ native = true, localStore = {}, fsImpl = fakeFs(), share } = {}) {
  const shared = [];
  const window = {
    localStorage: {
      getItem: (k) => (k in localStore ? localStore[k] : null),
      setItem: (k, v) => { localStore[k] = String(v); },
    },
    Capacitor: {
      isNativePlatform: () => native,
      getPlatform: () => (native ? 'android' : 'web'),
      Plugins: {
        Filesystem: fsImpl.Filesystem,
        Share: share === null ? undefined : (share || { async share(opts) { shared.push(opts); } }),
      },
    },
  };
  const sandbox = { window, localStorage: window.localStorage, console: { warn() {}, info() {}, log() {} }, Date, JSON, Promise, String };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { window, fs: fsImpl, shared };
}

test('outside a native shell it does nothing', () => {
  const { window } = run({ native: false });
  assert.equal(window.stickyNative, undefined);
  assert.equal(window.stickyWebStore, undefined);
  assert.equal(window.stickyShareFile, undefined);
});

test('without Capacitor at all it does nothing', () => {
  const window = {};
  const sandbox = { window, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  assert.deepEqual(Object.keys(window), []);
});

test('inside the Android app it sets all three seams', () => {
  const { window } = run();
  assert.equal(window.stickyNative.platform, 'android');
  assert.equal(typeof window.stickyWebStore.load, 'function');
  assert.equal(typeof window.stickyWebStore.save, 'function');
  assert.equal(typeof window.stickyShareFile, 'function');
});

test('save then load round-trips through notes.json', async () => {
  const { window, fs: f } = run();
  const data = { notes: [{ id: 'a', title: 'Olá', body: 'ção ✓' }], folders: [] };
  await window.stickyWebStore.save(data);
  assert.ok(f.files.has('DATA/notes.json'));
  assert.ok(!f.files.has('DATA/notes.json.tmp'), 'the tmp file is gone after the swap');
  assert.deepEqual(JSON.parse(JSON.stringify(await window.stickyWebStore.load())), data);
});

test('a second save replaces the first (tmp written, old deleted, tmp renamed)', async () => {
  const { window, fs: f } = run();
  await window.stickyWebStore.save({ n: 1 });
  f.log.length = 0;
  await window.stickyWebStore.save({ n: 2 });
  assert.deepEqual(f.log, ['write notes.json.tmp', 'delete notes.json', 'rename notes.json.tmp notes.json']);
  assert.equal((await window.stickyWebStore.load()).n, 2);
});

test('saves run one after another, so the newest store always wins', async () => {
  const { window } = run();
  await Promise.all([1, 2, 3, 4, 5].map(n => window.stickyWebStore.save({ n })));
  assert.equal((await window.stickyWebStore.load()).n, 5);
});

test('one failed save does not block the ones after it', async () => {
  const f = fakeFs();
  const realWrite = f.Filesystem.writeFile;
  let fail = true;
  f.Filesystem.writeFile = async (o) => { if (fail) { fail = false; throw new Error('disk full'); } return realWrite(o); };
  const { window } = run({ fsImpl: f });
  await assert.rejects(window.stickyWebStore.save({ n: 1 }), /disk full/);
  await window.stickyWebStore.save({ n: 2 });
  assert.equal((await window.stickyWebStore.load()).n, 2);
});

test('a save interrupted after deleting notes.json is recovered from the tmp file', async () => {
  const f = fakeFs();
  f.files.set('DATA/notes.json.tmp', JSON.stringify({ n: 7 }));
  const { window } = run({ fsImpl: f });
  assert.equal((await window.stickyWebStore.load()).n, 7);
});

test('first launch picks up notes an earlier build kept in localStorage', async () => {
  const { window } = run({ localStore: { 'stickies.all': JSON.stringify({ notes: [{ id: 'x' }] }) } });
  assert.equal((await window.stickyWebStore.load()).notes[0].id, 'x');
});

test('first launch with nothing anywhere starts empty', async () => {
  const { window } = run();
  assert.deepEqual(JSON.parse(JSON.stringify(await window.stickyWebStore.load())), {});
});

test('an unreadable notes.json is put aside before the app can overwrite it', async () => {
  const f = fakeFs();
  f.files.set('DATA/notes.json', '{"notes": [ broken');
  const { window } = run({ fsImpl: f });
  assert.deepEqual(JSON.parse(JSON.stringify(await window.stickyWebStore.load())), {});
  const aside = [...f.files.keys()].find(k => /^DATA\/notes\.corrupt-\d+\.json$/.test(k));
  assert.ok(aside, 'a notes.corrupt-<time>.json copy exists');
  assert.equal(f.files.get(aside), '{"notes": [ broken');
});

test('a download goes to the share sheet as a file in the cache dir', async () => {
  const { window, fs: f, shared } = run();
  const blob = { text: async () => '# hello' };
  await window.stickyShareFile('my/note:1.md', blob);
  assert.equal(f.files.get('CACHE/my_note_1.md'), '# hello', 'path separators are not allowed in the name');
  assert.equal(shared.length, 1);
  assert.deepEqual([...shared[0].files], ['file:///cache/my_note_1.md']);
});

test('closing the share sheet without choosing is not an error', async () => {
  const { window } = run({ share: { async share() { throw new Error('Share canceled'); } } });
  await window.stickyShareFile('a.json', { text: async () => '{}' });
});

test('without the Share plugin there is no share seam (downloads fall back to the browser path)', () => {
  const { window } = run({ share: null });
  assert.equal(window.stickyShareFile, undefined);
  assert.ok(window.stickyWebStore, 'storage still works');
});

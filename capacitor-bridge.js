// Android build only (Capacitor). build-web.mjs puts this script into
// www/index.html ahead of the app; the desktop app and the web demo never
// load it, and it does nothing outside a native Capacitor shell.
//
// It plugs the web build's three native seams:
//
//   window.stickyNative    — "this is the installed app": no "web demo"
//                            banner, no service worker.
//   window.stickyWebStore  — where the notes live: notes.json in the app's
//                            private files dir (Filesystem plugin), the same
//                            JSON the desktop app writes, instead of
//                            localStorage. useStickyStore (hooks.jsx) calls
//                            load() once and save() after every change.
//   window.stickyShareFile — what a "download" does: there are no browser
//                            downloads in a WebView, so exports (JSON backup,
//                            a note as Markdown) go to the system share sheet
//                            (Drive, Files, e-mail…). downloadBlob, utils.jsx.
//
// The plugins are reached through window.Capacitor, which the native bridge
// injects into the page, so no npm package is loaded in the browser.
(function () {
  'use strict';
  const cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return;
  const { Filesystem, Share } = cap.Plugins || {};
  if (!Filesystem) { console.warn('[native] Filesystem plugin missing'); return; }

  window.stickyNative = { platform: cap.getPlatform() };

  const DIR = 'DATA';                 // Directory.Data: app-private, kept until uninstall
  const FILE = 'notes.json';
  const TMP = 'notes.json.tmp';
  const UTF8 = 'utf8';

  const read = async (path) =>
    (await Filesystem.readFile({ path, directory: DIR, encoding: UTF8 })).data;
  const exists = async (path) => {
    try { await Filesystem.stat({ path, directory: DIR }); return true; } catch { return false; }
  };

  // Saves never overlap: each waits for the one before, so an older store can
  // never land on disk after a newer one.
  let chain = Promise.resolve();

  window.stickyWebStore = {
    async load() {
      // A save interrupted between "delete notes.json" and "rename the tmp"
      // leaves only the tmp file, which is complete: use it.
      const path = (await exists(FILE)) ? FILE : (await exists(TMP)) ? TMP : null;
      if (!path) {
        // First launch. Keep notes from an earlier build that still used
        // localStorage; the first save moves them to notes.json.
        try { return JSON.parse(localStorage.getItem('stickies.all') ?? '{}'); } catch { return {}; }
      }
      const raw = await read(path);
      try {
        return JSON.parse(raw);
      } catch (err) {
        // Unreadable: the app starts empty and its first save would overwrite
        // the file, so put it aside first rather than lose it for good.
        const aside = `notes.corrupt-${Date.now()}.json`;
        await Filesystem.writeFile({ path: aside, data: raw, directory: DIR, encoding: UTF8 });
        console.warn(`[native] ${path} unreadable (${err.message}); kept as ${aside}`);
        return {};
      }
    },

    save(data) {
      const json = JSON.stringify(data, null, 2);
      chain = chain.then(async () => {
        // Write the tmp file completely, then swap it in, so a crash midway
        // leaves either the old notes.json or a whole new one, never half.
        await Filesystem.writeFile({ path: TMP, data: json, directory: DIR, encoding: UTF8 });
        try { await Filesystem.deleteFile({ path: FILE, directory: DIR }); } catch { /* first save */ }
        await Filesystem.rename({ from: TMP, to: FILE, directory: DIR, toDirectory: DIR });
      });
      const done = chain;
      chain = chain.catch(() => {});   // one failed save must not block the next
      return done;
    },
  };

  if (Share) {
    window.stickyShareFile = async (filename, blob) => {
      const safe = String(filename).replace(/[\/\\:*?"<>|]+/g, '_') || 'export';
      await Filesystem.writeFile({ path: safe, data: await blob.text(), directory: 'CACHE', encoding: UTF8 });
      const { uri } = await Filesystem.getUri({ path: safe, directory: 'CACHE' });
      try {
        await Share.share({ title: safe, files: [uri] });
      } catch (err) {
        // Closing the share sheet without picking anything rejects; that is
        // not an error worth reporting.
        if (!/cancel/i.test(String(err && err.message))) throw err;
      }
    };
  }
})();

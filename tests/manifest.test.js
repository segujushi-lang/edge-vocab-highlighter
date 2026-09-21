const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const root = resolve(__dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));

test("manifest is a loadable MV3 extension with the required APIs", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.permissions.includes("contextMenus"));
  assert.ok(manifest.host_permissions.includes("https://api.mymemory.translated.net/*"));
  assert.equal(manifest.background.service_worker, "background.js");
});

test("every local file referenced by the manifest exists", () => {
  const paths = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((script) => [...script.js, ...script.css])
  ];
  for (const path of paths) {
    assert.equal(existsSync(resolve(root, path)), true, `Missing manifest file: ${path}`);
  }
});

test("content script runs on ordinary HTTP and HTTPS pages", () => {
  const matches = manifest.content_scripts[0].matches;
  assert.deepEqual(matches, ["http://*/*", "https://*/*"]);
});

test("color picker previews the highlight with dark and light page text", () => {
  const popupHtml = readFileSync(resolve(root, "popup.html"), "utf8");
  const popupCss = readFileSync(resolve(root, "popup.css"), "utf8");
  assert.match(popupHtml, /class="preview-surface preview-light"/);
  assert.match(popupHtml, /class="preview-surface preview-dark"/);
  assert.match(popupCss, /\.preview-dark\s*\{[^}]*color:\s*#f8fafc/s);
  assert.match(popupCss, /rgb\(var\(--preview-rgb\)\s*\/\s*82%\)/);
});

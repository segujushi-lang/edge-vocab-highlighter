const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

function loadUtils() {
  const context = vm.createContext({
    globalThis: {},
    Date,
    Object,
    Array,
    Set,
    RegExp,
    String,
    Number
  });
  const source = readFileSync(resolve(__dirname, "..", "shared.js"), "utf8");
  vm.runInContext(source, context, { filename: "shared.js" });
  return context.globalThis.VocabGlowUtils;
}

const utils = loadUtils();

test("cleans punctuation variants and creates case-insensitive keys", () => {
  assert.equal(utils.cleanWord("  Don’t  "), "Don't");
  assert.equal(utils.normalizeKey("Serendipity"), "serendipity");
  assert.equal(utils.normalizeKey("two words"), "");
});

test("accepts English words with apostrophes and hyphens only", () => {
  assert.equal(utils.isValidWord("state-of-the-art"), true);
  assert.equal(utils.isValidWord("don't"), true);
  assert.equal(utils.isValidWord("hello!"), false);
  assert.equal(utils.isValidWord("中文"), false);
});

test("word matcher respects English word boundaries and longest match", () => {
  const matcher = utils.buildWordMatcher(["cat", "state-of-the-art", "don't"]);
  const text = "Cat category bobcat cat-like state-of-the-art, don't.";
  const matches = [];
  let match = matcher.exec(text);
  while (match) {
    matches.push(match[2].toLowerCase());
    match = matcher.exec(text);
  }
  assert.deepEqual(matches, ["cat", "cat", "state-of-the-art", "don't"]);
});

test("sanitizes persisted entries and ignores invalid records", () => {
  const entries = utils.sanitizeEntries({
    Valid: {
      word: "Insight",
      translation: " 洞见 ",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z"
    },
    Invalid: { word: "two words", translation: "短语" }
  });
  assert.deepEqual(Object.keys(entries), ["insight"]);
  assert.equal(entries.insight.translation, "洞见");
  assert.equal(entries.insight.translationStatus, "ready");
});

test("sanitizes highlight settings and converts the selected color to RGB", () => {
  const settings = utils.sanitizeSettings({ enabled: false, highlightColor: " #12ABef " });
  assert.equal(settings.enabled, false);
  assert.equal(settings.highlightColor, "#12abef");

  const fallback = utils.sanitizeSettings({ enabled: "false", highlightColor: "yellow" });
  assert.equal(fallback.enabled, true);
  assert.equal(fallback.highlightColor, utils.DEFAULT_HIGHLIGHT_COLOR);

  const rgb = utils.getHighlightRgb(settings.highlightColor);
  assert.equal(rgb.red, 18);
  assert.equal(rgb.green, 171);
  assert.equal(rgb.blue, 239);
});

test("decodes translation entities and recognizes Chinese text", () => {
  assert.equal(utils.decodeHtmlEntities("洞见 &amp; 灵感 &#x4E50;"), "洞见 & 灵感 乐");
  assert.equal(utils.hasChineseText("意外发现"), true);
  assert.equal(utils.hasChineseText("serendipity"), false);
});

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

test("migrates legacy words and global color into the default category", () => {
  const settings = utils.sanitizeSettings({ enabled: false, highlightColor: "#12abef" });
  assert.equal(settings.categories.default.name, "默认分类");
  assert.equal(settings.categories.default.color, "#12abef");
  assert.equal(settings.highlightColor, "#12abef");

  const entries = utils.sanitizeEntries({
    insight: { word: "Insight", translation: "洞见" }
  }, settings.categories);
  assert.equal(entries.insight.categoryId, utils.DEFAULT_CATEGORY_ID);
  assert.equal(utils.getCategoryColor(settings, entries.insight.categoryId), "#12abef");
});

test("sanitizes custom categories and repairs missing category references", () => {
  const settings = utils.sanitizeSettings({
    enabled: true,
    categories: {
      default: { id: "default", name: "基础", color: "#ffdd57" },
      study: { id: "study", name: "学习", color: "#7DD3FC" },
      duplicate: { id: "duplicate", name: "学习", color: "#000000" },
      invalid: { id: "not valid", name: "无效", color: "red" }
    }
  });
  assert.deepEqual(Object.keys(settings.categories), ["default", "study"]);
  assert.equal(settings.categories.study.color, "#7dd3fc");

  const entries = utils.sanitizeEntries({
    curious: { word: "Curious", categoryId: "study" },
    epiphany: { word: "Epiphany", categoryId: "missing" }
  }, settings.categories);
  assert.equal(entries.curious.categoryId, "study");
  assert.equal(entries.epiphany.categoryId, "default");
});

test("summarizes undo and redo history without exposing snapshots", () => {
  const status = utils.summarizeHistory({
    undo: [{ description: "添加 Insight", entries: { secret: true } }],
    redo: [{ description: "删除 Curious", settings: { secret: true } }]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(status)), {
    canUndo: true,
    canRedo: true,
    undoLabel: "添加 Insight",
    redoLabel: "删除 Curious"
  });

  assert.equal(utils.summarizeHistory(null).canUndo, false);
  assert.equal(utils.summarizeHistory(status).redoLabel, "删除 Curious");
});

test("parses TXT and Markdown word lists with translations and duplicates", () => {
  const parsed = utils.parseWordImportText(`\uFEFF# Vocabulary
Serendipity
- curious - 好奇的
1. **Insight**：洞见
| word | translation |
| --- | --- |
| \`epiphany\` | 顿悟 |
state-of-the-art\t最先进的
serendipity: 意外发现
two words together
\`\`\`
ignored
\`\`\``);

  assert.deepEqual(JSON.parse(JSON.stringify(parsed.items)), [
    { word: "Serendipity", translation: "意外发现" },
    { word: "curious", translation: "好奇的" },
    { word: "Insight", translation: "洞见" },
    { word: "epiphany", translation: "顿悟" },
    { word: "state-of-the-art", translation: "最先进的" }
  ]);
  assert.equal(parsed.duplicateCount, 1);
  assert.equal(parsed.invalidCount, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.invalidLineNumbers)), [10]);
  assert.ok(parsed.ignoredCount >= 5);
});

test("limits import size while keeping the first unique words", () => {
  const parsed = utils.parseWordImportText("alpha\nbeta\ngamma\nALPHA", 2);
  assert.deepEqual(parsed.items.map((item) => item.word), ["alpha", "beta"]);
  assert.equal(parsed.overLimitCount, 1);
  assert.equal(parsed.duplicateCount, 1);
});

test("decodes translation entities and recognizes Chinese text", () => {
  assert.equal(utils.decodeHtmlEntities("洞见 &amp; 灵感 &#x4E50;"), "洞见 & 灵感 乐");
  assert.equal(utils.hasChineseText("意外发现"), true);
  assert.equal(utils.hasChineseText("serendipity"), false);
});

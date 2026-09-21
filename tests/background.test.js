const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");

const root = resolve(__dirname, "..");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createBackgroundHarness({ fetchImpl } = {}) {
  const local = {};
  const session = {};
  let fetchCalls = 0;
  const fetchUrls = [];
  let messageListener;
  let commandListener;

  function createStorageArea(store) {
    return {
      async get(keys) {
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(requested.flatMap((key) => (
          Object.hasOwn(store, key) ? [[key, clone(store[key])]] : []
        )));
      },
      async set(updates) {
        Object.assign(store, clone(updates));
      }
    };
  }

  const chrome = {
    commands: {
      onCommand: { addListener(listener) { commandListener = listener; } }
    },
    contextMenus: {
      onClicked: { addListener() {} },
      removeAll(callback) { callback(); },
      create(_options, callback) { callback(); }
    },
    runtime: {
      lastError: null,
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(listener) { messageListener = listener; } }
    },
    storage: {
      local: createStorageArea(local),
      session: createStorageArea(session)
    },
    tabs: {
      query(_options, callback) { callback([]); },
      sendMessage(_tabId, _message, callback) { callback(); }
    }
  };

  const context = vm.createContext({
    AbortController,
    URL,
    chrome,
    console: { warn() {} },
    fetch: async (url, options) => {
      fetchCalls += 1;
      fetchUrls.push(String(url));
      if (fetchImpl) {
        return fetchImpl(url, options);
      }
      throw new Error("Unexpected network request in background test");
    },
    setTimeout,
    clearTimeout
  });
  context.importScripts = (filename) => {
    vm.runInContext(readFileSync(resolve(root, filename), "utf8"), context, { filename });
  };
  vm.runInContext(readFileSync(resolve(root, "background.js"), "utf8"), context, { filename: "background.js" });

  return {
    local,
    session,
    get fetchCalls() { return fetchCalls; },
    fetchUrls,
    async send(message) {
      return new Promise((resolveResponse) => {
        messageListener(message, {}, resolveResponse);
      });
    },
    async command(name) {
      commandListener(name);
      await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    }
  };
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return clone(value); }
  };
}

test("default MyMemory source stores multiple deduplicated translations", async () => {
  const harness = createBackgroundHarness({
    fetchImpl(url) {
      assert.equal(new URL(url).hostname, "api.mymemory.translated.net");
      return jsonResponse({
        responseStatus: 200,
        responseData: { translatedText: "意外发现" },
        matches: [
          { translation: "意外发现" },
          { translation: "机缘" },
          { translation: "serendipity" }
        ]
      });
    }
  });

  const response = await harness.send({ type: "ADD_WORD", word: "Serendipity" });
  assert.equal(response.ok, true);
  assert.equal(harness.fetchCalls, 1);
  assert.deepEqual(clone(response.entry.translationResults.map((result) => result.text)), ["意外发现", "机缘"]);
  assert.deepEqual(clone(response.entry.translationResults.map((result) => result.source)), ["mymemory", "mymemory"]);
  assert.equal(response.entry.translation, "意外发现");
});

test("opted-in Wiktionary survives another source failure and keeps manual text first", async () => {
  const harness = createBackgroundHarness({
    fetchImpl(url) {
      const hostname = new URL(url).hostname;
      if (hostname === "api.mymemory.translated.net") {
        throw new Error("MyMemory unavailable");
      }
      assert.equal(hostname, "zh.wiktionary.org");
      return jsonResponse({
        query: {
          pages: [{
            title: "curious",
            extract: "== 英语 ==\n=== 形容词 ===\ncurious (比較級 more curious)\n好奇的\n奇怪的"
          }]
        }
      });
    }
  });

  const sourceChange = await harness.send({
    type: "SET_TRANSLATION_SOURCE",
    source: "wiktionary",
    enabled: true
  });
  assert.equal(sourceChange.settings.translationSources.wiktionary, true);
  assert.equal(harness.fetchCalls, 0);

  const added = await harness.send({ type: "ADD_WORD", word: "Curious" });
  assert.equal(added.entry.translationStatus, "ready");
  assert.equal(harness.fetchCalls, 2);
  assert.deepEqual(clone(added.entry.translationResults.map((result) => result.text)), ["好奇的", "奇怪的"]);
  assert.ok(added.entry.translationResults.every((result) => result.source === "wiktionary"));

  await harness.send({ type: "UPDATE_TRANSLATION", key: "curious", translation: "好奇；稀奇" });
  const retried = await harness.send({ type: "RETRY_TRANSLATION", key: "curious" });
  assert.equal(retried.entry.translation, "好奇；稀奇");
  assert.equal(retried.entry.translationResults[0].source, "manual");
  assert.ok(retried.entry.translationResults.some((result) => result.source === "wiktionary"));
});

test("translation source opt-in is reversible and never performs a lookup by itself", async () => {
  const harness = createBackgroundHarness();
  await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "wiktionary", enabled: true });
  assert.equal(harness.local.vocabSettings.translationSources.wiktionary, true);
  assert.equal(harness.fetchCalls, 0);
  await harness.send({ type: "UNDO_LAST_ACTION" });
  assert.equal(harness.local.vocabSettings.translationSources.wiktionary, false);
  assert.equal(harness.fetchCalls, 0);
});

test("disabling every automatic source prevents all translation requests", async () => {
  const harness = createBackgroundHarness();
  await harness.send({ type: "SET_TRANSLATION_SOURCE", source: "mymemory", enabled: false });
  const added = await harness.send({ type: "ADD_WORD", word: "Private" });
  assert.equal(added.entry.translationStatus, "error");
  assert.equal(added.entry.translationResults.length, 0);
  assert.equal(harness.fetchCalls, 0);
});

test("background history restores entries and settings through undo and redo", async () => {
  const harness = createBackgroundHarness();

  const added = await harness.send({
    type: "ADD_WORD",
    word: "Serendipity",
    translation: "意外发现"
  });
  assert.equal(added.ok, true);
  assert.equal(added.history.canUndo, true);

  const removed = await harness.send({ type: "REMOVE_WORD", key: "serendipity" });
  assert.equal(removed.ok, true);
  assert.equal(Object.keys(harness.local.vocabEntries).length, 0);

  const undone = await harness.send({ type: "UNDO_LAST_ACTION" });
  assert.equal(undone.changed, true);
  assert.equal(harness.local.vocabEntries.serendipity.translation, "意外发现");
  assert.equal(undone.history.canRedo, true);

  const redone = await harness.send({ type: "REDO_LAST_ACTION" });
  assert.equal(redone.changed, true);
  assert.equal(Object.keys(harness.local.vocabEntries).length, 0);

  await harness.send({ type: "SET_HIGHLIGHT_COLOR", highlightColor: "#123456" });
  assert.equal(harness.local.vocabSettings.highlightColor, "#123456");
  await harness.send({ type: "UNDO_LAST_ACTION" });
  assert.equal(harness.local.vocabSettings.highlightColor, "#ffdd57");
});

test("global toggle command uses the same reversible action history", async () => {
  const harness = createBackgroundHarness();
  await harness.command("toggle-highlighting");
  assert.equal(harness.local.vocabSettings.enabled, false);

  const state = await harness.send({ type: "GET_STATE" });
  assert.equal(state.history.canUndo, true);
  assert.match(state.history.undoLabel, /暂停网页高亮/);

  await harness.command("undo-last-action");
  assert.equal(harness.local.vocabSettings.enabled, true);
});

test("batch import skips existing words, stays local, and undoes as one action", async () => {
  const harness = createBackgroundHarness();
  await harness.send({
    type: "ADD_WORD",
    word: "Serendipity",
    translation: "原有释义"
  });

  const imported = await harness.send({
    type: "IMPORT_WORDS",
    items: [
      { word: "serendipity", translation: "不应覆盖" },
      { word: "Curious", translation: "好奇的" },
      { word: "Insight", translation: "" }
    ]
  });

  assert.equal(imported.ok, true);
  assert.equal(imported.importedCount, 2);
  assert.equal(imported.skippedExistingCount, 1);
  assert.equal(imported.untranslatedCount, 1);
  assert.equal(imported.history.undoLabel, "批量导入 2 个生词");
  assert.equal(harness.local.vocabEntries.serendipity.translation, "原有释义");
  assert.equal(harness.local.vocabEntries.curious.translation, "好奇的");
  assert.equal(harness.local.vocabEntries.insight.translationStatus, "error");
  assert.equal(harness.fetchCalls, 0);

  const undone = await harness.send({ type: "UNDO_LAST_ACTION" });
  assert.equal(undone.changed, true);
  assert.deepEqual(Object.keys(harness.local.vocabEntries), ["serendipity"]);

  const redone = await harness.send({ type: "REDO_LAST_ACTION" });
  assert.equal(redone.changed, true);
  assert.deepEqual(Object.keys(harness.local.vocabEntries).sort(), ["curious", "insight", "serendipity"]);
  assert.equal(harness.fetchCalls, 0);
});

test("categories control word colors and deletion moves words without deleting them", async () => {
  const harness = createBackgroundHarness();
  const created = await harness.send({
    type: "CREATE_CATEGORY",
    name: "考试重点",
    color: "#7dd3fc"
  });
  assert.equal(created.ok, true);
  const categoryId = created.category.id;
  assert.equal(harness.local.vocabSettings.categories[categoryId].color, "#7dd3fc");

  await harness.send({
    type: "ADD_WORD",
    word: "Epiphany",
    translation: "顿悟",
    categoryId
  });
  assert.equal(harness.local.vocabEntries.epiphany.categoryId, categoryId);

  const recolored = await harness.send({
    type: "UPDATE_CATEGORY",
    categoryId,
    color: "#c4b5fd"
  });
  assert.equal(recolored.category.color, "#c4b5fd");

  const deleted = await harness.send({ type: "DELETE_CATEGORY", categoryId });
  assert.equal(deleted.movedCount, 1);
  assert.equal(harness.local.vocabEntries.epiphany.categoryId, "default");
  assert.equal(harness.local.vocabSettings.categories[categoryId], undefined);

  await harness.send({ type: "UNDO_LAST_ACTION" });
  assert.equal(harness.local.vocabEntries.epiphany.categoryId, categoryId);
  assert.equal(harness.local.vocabSettings.categories[categoryId].color, "#c4b5fd");

  await harness.send({ type: "REDO_LAST_ACTION" });
  assert.equal(harness.local.vocabEntries.epiphany.categoryId, "default");
  assert.equal(harness.local.vocabEntries.epiphany.word, "Epiphany");

  const rejected = await harness.send({ type: "DELETE_CATEGORY", categoryId: "default" });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /默认分类不能删除/);
});

test("word moves and categorized imports are reversible", async () => {
  const harness = createBackgroundHarness();
  const created = await harness.send({ type: "CREATE_CATEGORY", name: "阅读", color: "#86efac" });
  const categoryId = created.category.id;

  const imported = await harness.send({
    type: "IMPORT_WORDS",
    categoryId,
    items: [{ word: "Curious", translation: "好奇的" }]
  });
  assert.equal(imported.ok, true);
  assert.equal(harness.local.vocabEntries.curious.categoryId, categoryId);

  const moved = await harness.send({ type: "MOVE_WORD", key: "curious", categoryId: "default" });
  assert.equal(moved.entry.categoryId, "default");
  assert.match(moved.history.undoLabel, /移到“默认分类”/);

  await harness.send({ type: "UNDO_LAST_ACTION" });
  assert.equal(harness.local.vocabEntries.curious.categoryId, categoryId);
  assert.equal(harness.fetchCalls, 0);
});

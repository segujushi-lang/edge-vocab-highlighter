const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");

const root = resolve(__dirname, "..");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createBackgroundHarness() {
  const local = {};
  const session = {};
  let fetchCalls = 0;
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
    console,
    fetch: async () => {
      fetchCalls += 1;
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

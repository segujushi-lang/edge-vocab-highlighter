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
    fetch,
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

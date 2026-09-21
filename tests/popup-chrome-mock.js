(() => {
  const now = new Date().toISOString();
  const state = {
    entries: {
      serendipity: {
        key: "serendipity",
        word: "Serendipity",
        translation: "意外发现",
        translationStatus: "ready",
        createdAt: now,
        updatedAt: now,
        sourceUrl: "",
        translationRequestId: ""
      }
    },
    settings: { enabled: true, highlightColor: "#ffdd57" },
    history: { canUndo: true, canRedo: false, undoLabel: "添加 Serendipity", redoLabel: "" }
  };
  const storageListeners = [];

  globalThis.__popupMessages = [];
  globalThis.chrome = {
    commands: {
      getAll(callback) {
        callback([
          { name: "_execute_action", shortcut: "Alt+Shift+S" },
          { name: "toggle-highlighting", shortcut: "Alt+Shift+H" },
          { name: "undo-last-action", shortcut: "Alt+Shift+Z" },
          { name: "redo-last-action", shortcut: "Alt+Shift+Y" }
        ]);
      }
    },
    runtime: {
      lastError: null,
      async sendMessage(message) {
        globalThis.__popupMessages.push(message);
        if (message.type === "GET_STATE") {
          return { ok: true, ...state };
        }
        if (message.type === "UNDO_LAST_ACTION") {
          state.history = { canUndo: false, canRedo: true, undoLabel: "", redoLabel: "添加 Serendipity" };
          return { ok: true, changed: true, message: "已撤回：添加 Serendipity", history: state.history };
        }
        if (message.type === "REDO_LAST_ACTION") {
          state.history = { canUndo: true, canRedo: false, undoLabel: "添加 Serendipity", redoLabel: "" };
          return { ok: true, changed: true, message: "已重做：添加 Serendipity", history: state.history };
        }
        if (message.type === "IMPORT_WORDS") {
          let importedCount = 0;
          let skippedExistingCount = 0;
          let untranslatedCount = 0;
          for (const item of message.items || []) {
            const key = String(item.word || "").toLocaleLowerCase("en-US");
            if (!key || state.entries[key]) {
              skippedExistingCount += 1;
              continue;
            }
            state.entries[key] = {
              key,
              word: item.word,
              translation: item.translation || "",
              translationStatus: item.translation ? "ready" : "error",
              createdAt: now,
              updatedAt: now,
              sourceUrl: "",
              translationRequestId: ""
            };
            importedCount += 1;
            if (!item.translation) {
              untranslatedCount += 1;
            }
          }
          state.history = {
            canUndo: importedCount > 0,
            canRedo: false,
            undoLabel: `批量导入 ${importedCount} 个生词`,
            redoLabel: ""
          };
          for (const listener of storageListeners) {
            listener({ vocabEntries: { newValue: state.entries } }, "local");
          }
          return {
            ok: true,
            importedCount,
            skippedExistingCount,
            untranslatedCount,
            history: state.history
          };
        }
        return { ok: true, ...state };
      }
    },
    storage: {
      onChanged: { addListener(listener) { storageListeners.push(listener); } }
    }
  };
})();

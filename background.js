importScripts("shared.js");

const {
  STORAGE_KEYS,
  cleanWord,
  isValidWord,
  normalizeKey,
  sanitizeEntries,
  isValidHighlightColor,
  normalizeHighlightColor,
  sanitizeSettings,
  summarizeHistory,
  decodeHtmlEntities,
  hasChineseText
} = globalThis.VocabGlowUtils;

const CONTEXT_MENU_ID = "vocab-glow-save-selection";
const TRANSLATION_ENDPOINT = "https://api.mymemory.translated.net/get";
const HISTORY_LIMIT = 20;

chrome.runtime.onInstalled.addListener(() => {
  void initializeStorage();
  rebuildContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  rebuildContextMenu();
});

chrome.commands.onCommand.addListener((command) => {
  void handleCommand(command).catch((error) => {
    console.warn("[拾词] 快捷键操作失败：", error);
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !info.selectionText) {
    return;
  }

  const displayWord = cleanWord(info.selectionText);
  void runWithHistory(`添加 ${displayWord}`, async () => ({
    entry: await saveWord({
      word: displayWord,
      sourceUrl: info.pageUrl || tab?.url || ""
    })
  }))
    .then(({ entry }) => notifyTab(tab?.id, { type: "WORD_SAVED", entry }))
    .catch((error) => notifyTab(tab?.id, {
      type: "WORD_SAVE_ERROR",
      message: error instanceof Error ? error.message : "保存失败"
    }));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "操作失败"
    }));

  return true;
});

async function initializeStorage() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.entries, STORAGE_KEYS.settings]);
  const updates = {};

  if (!stored[STORAGE_KEYS.entries] || typeof stored[STORAGE_KEYS.entries] !== "object") {
    updates[STORAGE_KEYS.entries] = {};
  }

  const storedSettings = stored[STORAGE_KEYS.settings];
  if (
    !storedSettings
    || typeof storedSettings !== "object"
    || typeof storedSettings.enabled !== "boolean"
    || !isValidHighlightColor(storedSettings.highlightColor)
  ) {
    updates[STORAGE_KEYS.settings] = sanitizeSettings(storedSettings);
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

function rebuildContextMenu() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "保存“%s”并高亮",
      contexts: ["selection"],
      documentUrlPatterns: ["http://*/*", "https://*/*"]
    }, () => {
      void chrome.runtime.lastError;
    });
  });
}

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== "string") {
    throw new Error("无效请求");
  }

  switch (message.type) {
    case "GET_STATE":
      return getClientState();
    case "ADD_WORD":
      return runWithHistory(`添加 ${cleanWord(message.word)}`, async () => ({
        entry: await saveWord({
          word: message.word,
          translation: message.translation,
          sourceUrl: message.sourceUrl || sender.tab?.url || ""
        })
      }));
    case "REMOVE_WORD":
      return runWithHistory(
        (before) => `删除 ${before.entries[normalizeKey(message.key)]?.word || cleanWord(message.key)}`,
        () => removeWord(message.key)
      );
    case "UPDATE_TRANSLATION":
      return runWithHistory(
        (before) => `修改 ${before.entries[normalizeKey(message.key)]?.word || cleanWord(message.key)} 的翻译`,
        async () => ({ entry: await updateTranslation(message.key, message.translation) })
      );
    case "RETRY_TRANSLATION":
      return runWithHistory(
        (before) => `重新翻译 ${before.entries[normalizeKey(message.key)]?.word || cleanWord(message.key)}`,
        async () => ({ entry: await retryTranslation(message.key) })
      );
    case "SET_ENABLED":
      return runWithHistory(message.enabled ? "开启网页高亮" : "暂停网页高亮", () => setEnabled(message.enabled));
    case "SET_HIGHLIGHT_COLOR":
      return runWithHistory("修改高亮颜色", () => setHighlightColor(message.highlightColor));
    case "CLEAR_WORDS":
      return runWithHistory("清空词库", clearWords);
    case "UNDO_LAST_ACTION":
      return undoLastAction();
    case "REDO_LAST_ACTION":
      return redoLastAction();
    default:
      throw new Error("未知操作");
  }
}

async function getClientState() {
  const [state, history] = await Promise.all([getState(), getHistory()]);
  return { ...state, history: summarizeHistory(history) };
}

async function getState() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.entries, STORAGE_KEYS.settings]);
  const entries = sanitizeEntries(stored[STORAGE_KEYS.entries]);
  const staleBefore = Date.now() - 30000;
  let recoveredStaleRequest = false;

  for (const entry of Object.values(entries)) {
    const updatedAt = Date.parse(entry.updatedAt);
    if (entry.translationStatus === "loading" && (!Number.isFinite(updatedAt) || updatedAt < staleBefore)) {
      entry.translationStatus = "error";
      entry.translationRequestId = "";
      recoveredStaleRequest = true;
    }
  }

  if (recoveredStaleRequest) {
    await chrome.storage.local.set({ [STORAGE_KEYS.entries]: entries });
  }

  return {
    entries,
    settings: sanitizeSettings(stored[STORAGE_KEYS.settings])
  };
}

async function setEntries(entries) {
  await chrome.storage.local.set({ [STORAGE_KEYS.entries]: entries });
}

async function saveWord({ word, translation = "", sourceUrl = "" }) {
  const displayWord = cleanWord(word);
  const key = normalizeKey(displayWord);

  if (!isValidWord(displayWord) || !key) {
    throw new Error("请选择一个完整的英文单词");
  }

  const manualTranslation = typeof translation === "string" ? translation.trim().slice(0, 240) : "";
  const { entries } = await getState();
  const now = new Date().toISOString();
  const existing = entries[key];
  const shouldTranslate = !manualTranslation && !existing?.translation;
  const requestId = shouldTranslate ? createRequestId() : "";

  const entry = {
    key,
    word: existing?.word || displayWord,
    translation: manualTranslation || existing?.translation || "",
    translationStatus: manualTranslation || existing?.translation ? "ready" : "loading",
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    sourceUrl: sanitizeSourceUrl(sourceUrl || existing?.sourceUrl || ""),
    translationRequestId: requestId
  };

  entries[key] = entry;
  await setEntries(entries);

  if (!shouldTranslate) {
    return entry;
  }

  return finishTranslation(key, requestId);
}

async function finishTranslation(key, requestId) {
  try {
    const translation = await translateWord(key);
    const { entries } = await getState();
    const current = entries[key];

    if (!current || current.translationRequestId !== requestId) {
      return current || null;
    }

    const updated = {
      ...current,
      translation,
      translationStatus: "ready",
      translationRequestId: "",
      updatedAt: new Date().toISOString()
    };
    entries[key] = updated;
    await setEntries(entries);
    return updated;
  } catch (error) {
    const { entries } = await getState();
    const current = entries[key];

    if (!current || current.translationRequestId !== requestId) {
      return current || null;
    }

    const updated = {
      ...current,
      translationStatus: "error",
      translationRequestId: "",
      updatedAt: new Date().toISOString()
    };
    entries[key] = updated;
    await setEntries(entries);
    console.warn("[拾词] 翻译失败：", error);
    return updated;
  }
}

async function translateWord(word) {
  const url = new URL(TRANSLATION_ENDPOINT);
  url.searchParams.set("q", word);
  url.searchParams.set("langpair", "en|zh-CN");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`翻译服务返回 ${response.status}`);
    }

    const data = await response.json();
    if (Number(data.responseStatus) !== 200) {
      throw new Error(data.responseDetails || "翻译服务暂时不可用");
    }

    const candidates = [
      data.responseData?.translatedText,
      ...(Array.isArray(data.matches) ? data.matches.map((match) => match?.translation) : [])
    ];

    for (const candidate of candidates) {
      const decoded = decodeHtmlEntities(candidate).trim();
      if (decoded && hasChineseText(decoded)) {
        return decoded.slice(0, 240);
      }
    }

    throw new Error("没有找到合适的中文翻译");
  } finally {
    clearTimeout(timeoutId);
  }
}

async function removeWord(value) {
  const key = normalizeKey(value);
  if (!key) {
    throw new Error("无效单词");
  }

  const { entries } = await getState();
  const removed = Boolean(entries[key]);
  delete entries[key];
  await setEntries(entries);
  return { removed, key };
}

async function updateTranslation(value, translation) {
  const key = normalizeKey(value);
  const nextTranslation = typeof translation === "string" ? translation.trim().slice(0, 240) : "";
  if (!key || !nextTranslation) {
    throw new Error("中文翻译不能为空");
  }

  const { entries } = await getState();
  if (!entries[key]) {
    throw new Error("这个单词已不在词库中");
  }

  entries[key] = {
    ...entries[key],
    translation: nextTranslation,
    translationStatus: "ready",
    translationRequestId: "",
    updatedAt: new Date().toISOString()
  };
  await setEntries(entries);
  return entries[key];
}

async function retryTranslation(value) {
  const key = normalizeKey(value);
  const { entries } = await getState();
  if (!key || !entries[key]) {
    throw new Error("这个单词已不在词库中");
  }

  const requestId = createRequestId();
  entries[key] = {
    ...entries[key],
    translation: "",
    translationStatus: "loading",
    translationRequestId: requestId,
    updatedAt: new Date().toISOString()
  };
  await setEntries(entries);
  return finishTranslation(key, requestId);
}

async function setEnabled(enabled) {
  const { settings } = await getState();
  const nextSettings = sanitizeSettings({ ...settings, enabled: Boolean(enabled) });
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: nextSettings });
  return { settings: nextSettings };
}

async function setHighlightColor(highlightColor) {
  if (!isValidHighlightColor(highlightColor)) {
    throw new Error("无效的高亮颜色");
  }

  const { settings } = await getState();
  const nextSettings = sanitizeSettings({
    ...settings,
    highlightColor: normalizeHighlightColor(highlightColor)
  });
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: nextSettings });
  return { settings: nextSettings };
}

async function clearWords() {
  await setEntries({});
  return { cleared: true };
}

async function runWithHistory(description, operation) {
  const before = await captureSnapshot();
  const result = await operation();
  const after = await captureSnapshot();
  let history = await getHistory();

  if (!snapshotsEqual(before, after)) {
    const resolvedDescription = typeof description === "function"
      ? description(before, after, result)
      : description;
    history.undo.push({
      ...before,
      description: String(resolvedDescription || "上一次操作")
    });
    history.undo = history.undo.slice(-HISTORY_LIMIT);
    history.redo = [];
    await setHistory(history);
  }

  return { ...(result || {}), history: summarizeHistory(history) };
}

async function undoLastAction() {
  const history = await getHistory();
  const checkpoint = history.undo.pop();
  if (!checkpoint) {
    return {
      changed: false,
      message: "没有可撤回的操作",
      history: summarizeHistory(history)
    };
  }

  const current = await captureSnapshot();
  await restoreSnapshot(checkpoint);
  history.redo.push({ ...current, description: checkpoint.description });
  history.redo = history.redo.slice(-HISTORY_LIMIT);
  await setHistory(history);
  return {
    changed: true,
    message: `已撤回：${checkpoint.description}`,
    history: summarizeHistory(history)
  };
}

async function redoLastAction() {
  const history = await getHistory();
  const checkpoint = history.redo.pop();
  if (!checkpoint) {
    return {
      changed: false,
      message: "没有可重做的操作",
      history: summarizeHistory(history)
    };
  }

  const current = await captureSnapshot();
  await restoreSnapshot(checkpoint);
  history.undo.push({ ...current, description: checkpoint.description });
  history.undo = history.undo.slice(-HISTORY_LIMIT);
  await setHistory(history);
  return {
    changed: true,
    message: `已重做：${checkpoint.description}`,
    history: summarizeHistory(history)
  };
}

async function captureSnapshot() {
  const { entries, settings } = await getState();
  return { entries, settings };
}

async function restoreSnapshot(snapshot) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.entries]: sanitizeEntries(snapshot.entries),
    [STORAGE_KEYS.settings]: sanitizeSettings(snapshot.settings)
  });
}

async function getHistory() {
  const stored = await chrome.storage.session.get(STORAGE_KEYS.history);
  const raw = stored[STORAGE_KEYS.history];
  return {
    undo: sanitizeCheckpoints(raw?.undo),
    redo: sanitizeCheckpoints(raw?.redo)
  };
}

function sanitizeCheckpoints(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(-HISTORY_LIMIT).flatMap((checkpoint) => {
    if (!checkpoint || typeof checkpoint !== "object") {
      return [];
    }
    return [{
      entries: sanitizeEntries(checkpoint.entries),
      settings: sanitizeSettings(checkpoint.settings),
      description: typeof checkpoint.description === "string"
        ? checkpoint.description.slice(0, 120)
        : "上一次操作"
    }];
  });
}

async function setHistory(history) {
  await chrome.storage.session.set({ [STORAGE_KEYS.history]: history });
}

function snapshotsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function handleCommand(command) {
  let result;
  if (command === "undo-last-action") {
    result = await undoLastAction();
  } else if (command === "redo-last-action") {
    result = await redoLastAction();
  } else if (command === "toggle-highlighting") {
    const { settings } = await getState();
    result = await runWithHistory(
      settings.enabled ? "暂停网页高亮" : "开启网页高亮",
      () => setEnabled(!settings.enabled)
    );
    result.message = result.settings.enabled ? "网页高亮已开启" : "网页高亮已暂停";
  } else {
    return;
  }

  notifyAllTabs({ type: "HISTORY_NOTICE", message: result.message || "操作完成" });
}

function sanitizeSourceUrl(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.slice(0, 2048);
}

function createRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function notifyTab(tabId, message) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  chrome.tabs.sendMessage(tabId, message, () => {
    void chrome.runtime.lastError;
  });
}

function notifyAllTabs(message) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      notifyTab(tab.id, message);
    }
  });
}

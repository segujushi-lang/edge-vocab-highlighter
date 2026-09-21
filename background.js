importScripts("shared.js");

const {
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  cleanWord,
  isValidWord,
  normalizeKey,
  sanitizeEntries,
  decodeHtmlEntities,
  hasChineseText
} = globalThis.VocabGlowUtils;

const CONTEXT_MENU_ID = "vocab-glow-save-selection";
const TRANSLATION_ENDPOINT = "https://api.mymemory.translated.net/get";

chrome.runtime.onInstalled.addListener(() => {
  void initializeStorage();
  rebuildContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  rebuildContextMenu();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !info.selectionText) {
    return;
  }

  void saveWord({
    word: info.selectionText,
    sourceUrl: info.pageUrl || tab?.url || ""
  })
    .then((entry) => notifyTab(tab?.id, { type: "WORD_SAVED", entry }))
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

  if (!stored[STORAGE_KEYS.settings] || typeof stored[STORAGE_KEYS.settings] !== "object") {
    updates[STORAGE_KEYS.settings] = { ...DEFAULT_SETTINGS };
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
      return getState();
    case "ADD_WORD":
      return {
        entry: await saveWord({
          word: message.word,
          translation: message.translation,
          sourceUrl: message.sourceUrl || sender.tab?.url || ""
        })
      };
    case "REMOVE_WORD":
      return removeWord(message.key);
    case "UPDATE_TRANSLATION":
      return { entry: await updateTranslation(message.key, message.translation) };
    case "RETRY_TRANSLATION":
      return { entry: await retryTranslation(message.key) };
    case "SET_ENABLED":
      return setEnabled(message.enabled);
    case "CLEAR_WORDS":
      return clearWords();
    default:
      throw new Error("未知操作");
  }
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
    settings: {
      ...DEFAULT_SETTINGS,
      ...(stored[STORAGE_KEYS.settings] || {})
    }
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
  const nextSettings = { ...settings, enabled: Boolean(enabled) };
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: nextSettings });
  return { settings: nextSettings };
}

async function clearWords() {
  await setEntries({});
  return { cleared: true };
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

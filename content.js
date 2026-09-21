(function startContentScript() {
  "use strict";

  const {
    STORAGE_KEYS,
    DEFAULT_SETTINGS,
    cleanWord,
    isValidWord,
    normalizeKey,
    buildWordMatcher,
    sanitizeEntries,
    sanitizeSettings,
    getHighlightRgb
  } = globalThis.VocabGlowUtils;

  const HIGHLIGHT_SELECTOR = "mark.sl-word-highlight[data-vocab-word]";
  const EXCLUDED_SELECTOR = [
    "script",
    "style",
    "noscript",
    "textarea",
    "input",
    "select",
    "option",
    "button",
    "code",
    "pre",
    "kbd",
    "samp",
    "svg",
    "math",
    "[contenteditable='true']",
    "[contenteditable='plaintext-only']"
  ].join(",");

  let entries = {};
  let settings = { ...DEFAULT_SETTINGS };
  let matcher = null;
  let observer = null;
  let refreshTimer = 0;
  let mutationTimer = 0;
  let currentSelection = null;
  let openCardKey = "";
  const pendingRoots = new Set();

  const ui = createUi();
  bindUiEvents();
  bindPageEvents();
  void bootstrap();

  async function bootstrap() {
    try {
      const response = await sendMessage({ type: "GET_STATE" });
      if (!response.ok) {
        throw new Error(response.error || "无法读取词库");
      }

      entries = sanitizeEntries(response.entries);
      settings = sanitizeSettings(response.settings);
      matcher = buildWordMatcher(Object.keys(entries));
      refreshAllHighlights();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "拾词初始化失败", "error");
    } finally {
      startObserver();
    }
  }

  function createUi() {
    const host = document.createElement("div");
    host.id = "sl-extension-root";
    host.setAttribute("data-vocab-glow-ui", "");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    (document.documentElement || document.body).append(host);

    const shadow = host.attachShadow({ mode: "closed" });
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        button { font: inherit; }
        .hidden { display: none !important; }
        .selection-button {
          align-items: center; background: #111827; border: 1px solid rgba(255,255,255,.12);
          border-radius: 999px; box-shadow: 0 10px 30px rgba(15,23,42,.28); color: #fff;
          cursor: pointer; display: flex; font: 600 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
          gap: 6px; left: 0; padding: 9px 13px; pointer-events: auto; position: fixed; top: 0;
          transform: translate(-50%, 0); white-space: nowrap;
        }
        .selection-button:hover { background: #1f2937; transform: translate(-50%, -1px); }
        .selection-button svg { height: 15px; width: 15px; }
        .card {
          background: rgba(255,255,255,.98); border: 1px solid rgba(15,23,42,.10); border-radius: 16px;
          box-shadow: 0 18px 50px rgba(15,23,42,.22); color: #172033; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
          left: 0; max-width: min(320px, calc(100vw - 24px)); min-width: 240px; padding: 17px;
          pointer-events: auto; position: fixed; top: 0;
        }
        .card-head { align-items: flex-start; display: flex; gap: 12px; justify-content: space-between; }
        .word { color: #0f172a; font: 750 21px/1.15 Georgia,"Times New Roman",serif; margin: 0; overflow-wrap: anywhere; }
        .label { color: #94a3b8; font: 700 10px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing: .12em; margin: 0 0 5px; text-transform: uppercase; }
        .close { background: transparent; border: 0; border-radius: 8px; color: #94a3b8; cursor: pointer; font: 20px/1 sans-serif; margin: -5px -5px 0 0; padding: 5px 7px; }
        .close:hover { background: #f1f5f9; color: #334155; }
        .translation { color: #334155; font: 500 15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; margin: 13px 0 16px; min-height: 24px; overflow-wrap: anywhere; }
        .translation.loading { color: #64748b; }
        .translation.error { color: #b45309; }
        .actions { align-items: center; display: flex; gap: 8px; justify-content: flex-end; }
        .action { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 9px; color: #475569; cursor: pointer; font: 650 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; padding: 8px 10px; }
        .action:hover { background: #f1f5f9; border-color: #cbd5e1; }
        .action.danger { color: #be123c; }
        .toast {
          background: #0f172a; border: 1px solid rgba(255,255,255,.1); border-radius: 11px;
          bottom: 22px; box-shadow: 0 12px 34px rgba(15,23,42,.28); color: #fff;
          font: 600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
          left: 50%; max-width: min(420px, calc(100vw - 32px)); padding: 11px 15px; pointer-events: none;
          position: fixed; text-align: center; transform: translate(-50%, 12px); transition: opacity .18s ease, transform .18s ease;
        }
        .toast.visible { opacity: 1; transform: translate(-50%, 0); }
        .toast.error { background: #881337; }
      </style>
      <button class="selection-button hidden" id="selectionButton" type="button" aria-label="保存所选单词">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        保存并高亮
      </button>
      <section class="card hidden" id="wordCard" role="dialog" aria-label="单词释义">
        <div class="card-head">
          <div><p class="label">Saved word</p><h2 class="word" id="cardWord"></h2></div>
          <button class="close" id="cardClose" type="button" aria-label="关闭">×</button>
        </div>
        <p class="translation" id="cardTranslation"></p>
        <div class="actions">
          <button class="action hidden" id="cardRetry" type="button">重试翻译</button>
          <button class="action danger" id="cardRemove" type="button">移出词库</button>
        </div>
      </section>
      <div class="toast hidden" id="toast" role="status" aria-live="polite"></div>
    `;
    shadow.append(wrapper);

    return {
      host,
      selectionButton: shadow.getElementById("selectionButton"),
      card: shadow.getElementById("wordCard"),
      cardWord: shadow.getElementById("cardWord"),
      cardTranslation: shadow.getElementById("cardTranslation"),
      cardClose: shadow.getElementById("cardClose"),
      cardRetry: shadow.getElementById("cardRetry"),
      cardRemove: shadow.getElementById("cardRemove"),
      toast: shadow.getElementById("toast"),
      toastTimer: 0
    };
  }

  function bindUiEvents() {
    ui.selectionButton.addEventListener("pointerdown", (event) => event.preventDefault());
    ui.selectionButton.addEventListener("click", () => void saveCurrentSelection());
    ui.cardClose.addEventListener("click", hideCard);
    ui.cardRemove.addEventListener("click", () => void removeOpenWord());
    ui.cardRetry.addEventListener("click", () => void retryOpenWord());
  }

  function bindPageEvents() {
    document.addEventListener("mouseup", handleMouseUp, true);
    document.addEventListener("click", handlePageClick, true);
    document.addEventListener("pointerdown", handlePagePointerDown, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hideSelectionButton();
        hideCard();
      }
    }, true);
    window.addEventListener("scroll", hideTransientUi, { capture: true, passive: true });
    window.addEventListener("resize", hideTransientUi, { passive: true });

    chrome.storage.onChanged.addListener(handleStorageChange);
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "WORD_SAVED" && message.entry) {
        const detail = message.entry.translation
          ? `${message.entry.word}：${message.entry.translation}`
          : `${message.entry.word} 已保存，可稍后重试翻译`;
        showToast(detail);
      }

      if (message?.type === "WORD_SAVE_ERROR") {
        showToast(message.message || "保存失败", "error");
      }
    });
  }

  function handleMouseUp(event) {
    if (event.composedPath().includes(ui.host)) {
      return;
    }

    window.setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        hideSelectionButton();
        return;
      }

      const word = cleanWord(selection.toString());
      if (!isValidWord(word)) {
        hideSelectionButton();
        return;
      }

      const range = selection.getRangeAt(0);
      const container = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
      if (!container || container.closest?.(EXCLUDED_SELECTOR) || container.closest?.(HIGHLIGHT_SELECTOR)) {
        hideSelectionButton();
        return;
      }

      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        hideSelectionButton();
        return;
      }

      currentSelection = { word };
      const x = clamp(rect.left + rect.width / 2, 78, window.innerWidth - 78);
      const y = rect.bottom + 9;
      ui.selectionButton.style.left = `${x}px`;
      ui.selectionButton.style.top = `${Math.min(y, window.innerHeight - 46)}px`;
      ui.selectionButton.classList.remove("hidden");
    }, 0);
  }

  async function saveCurrentSelection() {
    const selection = currentSelection;
    hideSelectionButton();
    if (!selection) {
      return;
    }

    showToast(`正在保存 ${selection.word}…`);
    try {
      const response = await sendMessage({
        type: "ADD_WORD",
        word: selection.word,
        sourceUrl: location.href
      });
      if (!response.ok) {
        throw new Error(response.error || "保存失败");
      }

      const detail = response.entry?.translation
        ? `${response.entry.word}：${response.entry.translation}`
        : `${selection.word} 已保存，可稍后补充翻译`;
      showToast(detail);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "保存失败", "error");
    }
  }

  function handlePageClick(event) {
    const target = event.target instanceof Element ? event.target.closest(HIGHLIGHT_SELECTOR) : null;
    if (!target || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    hideSelectionButton();
    showCard(target.dataset.vocabWord, target.getBoundingClientRect());
  }

  function handlePagePointerDown(event) {
    const path = event.composedPath();
    if (path.includes(ui.host)) {
      return;
    }

    const target = event.target instanceof Element ? event.target.closest(HIGHLIGHT_SELECTOR) : null;
    if (!target) {
      hideCard();
    }
  }

  function showCard(value, anchorRect) {
    const key = normalizeKey(value);
    const entry = entries[key];
    if (!entry) {
      return;
    }

    openCardKey = key;
    renderOpenCard();
    ui.card.classList.remove("hidden");

    const estimatedHeight = entry.translationStatus === "error" ? 176 : 158;
    let top = anchorRect.bottom + 9;
    if (top + estimatedHeight > window.innerHeight - 12) {
      top = Math.max(12, anchorRect.top - estimatedHeight - 9);
    }
    const left = clamp(anchorRect.left + anchorRect.width / 2 - 130, 12, window.innerWidth - 332);
    ui.card.style.left = `${left}px`;
    ui.card.style.top = `${top}px`;
  }

  function renderOpenCard() {
    const entry = entries[openCardKey];
    if (!entry) {
      hideCard();
      return;
    }

    ui.cardWord.textContent = entry.word;
    ui.cardTranslation.className = "translation";
    ui.cardRetry.classList.add("hidden");

    if (entry.translationStatus === "loading") {
      ui.cardTranslation.textContent = "正在获取中文翻译…";
      ui.cardTranslation.classList.add("loading");
    } else if (entry.translation) {
      ui.cardTranslation.textContent = entry.translation;
    } else {
      ui.cardTranslation.textContent = "暂时没有获取到翻译，可重试或在扩展词库中手动补充。";
      ui.cardTranslation.classList.add("error");
      ui.cardRetry.classList.remove("hidden");
    }
  }

  async function removeOpenWord() {
    const key = openCardKey;
    const entry = entries[key];
    hideCard();
    if (!key || !entry) {
      return;
    }

    try {
      const response = await sendMessage({ type: "REMOVE_WORD", key });
      if (!response.ok) {
        throw new Error(response.error || "移除失败");
      }
      showToast(`${entry.word} 已移出词库`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "移除失败", "error");
    }
  }

  async function retryOpenWord() {
    const key = openCardKey;
    if (!key || !entries[key]) {
      return;
    }

    ui.cardTranslation.textContent = "正在重新翻译…";
    ui.cardTranslation.className = "translation loading";
    ui.cardRetry.classList.add("hidden");
    try {
      const response = await sendMessage({ type: "RETRY_TRANSLATION", key });
      if (!response.ok) {
        throw new Error(response.error || "翻译失败");
      }
      if (response.entry) {
        entries[key] = response.entry;
      }
      renderOpenCard();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "翻译失败", "error");
      renderOpenCard();
    }
  }

  function hideSelectionButton() {
    currentSelection = null;
    ui.selectionButton.classList.add("hidden");
  }

  function hideCard() {
    openCardKey = "";
    ui.card.classList.add("hidden");
  }

  function hideTransientUi() {
    hideSelectionButton();
    hideCard();
  }

  function showToast(message, variant = "default") {
    window.clearTimeout(ui.toastTimer);
    ui.toast.textContent = message;
    ui.toast.className = `toast ${variant === "error" ? "error" : ""}`.trim();
    ui.toast.classList.remove("hidden");
    requestAnimationFrame(() => ui.toast.classList.add("visible"));
    ui.toastTimer = window.setTimeout(() => {
      ui.toast.classList.remove("visible");
      window.setTimeout(() => ui.toast.classList.add("hidden"), 180);
    }, 2600);
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local") {
      return;
    }

    const previousKeys = Object.keys(entries).sort().join("|");
    const previousEnabled = settings.enabled;
    const previousHighlightColor = settings.highlightColor;

    if (changes[STORAGE_KEYS.entries]) {
      entries = sanitizeEntries(changes[STORAGE_KEYS.entries].newValue);
      matcher = buildWordMatcher(Object.keys(entries));
    }

    if (changes[STORAGE_KEYS.settings]) {
      settings = sanitizeSettings(changes[STORAGE_KEYS.settings].newValue);
    }

    const nextKeys = Object.keys(entries).sort().join("|");
    if (previousKeys !== nextKeys || previousEnabled !== settings.enabled) {
      scheduleFullRefresh();
    } else {
      if (previousHighlightColor !== settings.highlightColor) {
        applyHighlightColorToAll();
      }
      if (openCardKey) {
        renderOpenCard();
      }
    }
  }

  function scheduleFullRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refreshAllHighlights, 80);
  }

  function refreshAllHighlights() {
    pendingRoots.clear();
    withObserverPaused(() => {
      unwrapHighlights();
      if (settings.enabled && matcher && document.body) {
        highlightRoot(document.body);
      }
    });
  }

  function unwrapHighlights() {
    const parents = new Set();
    for (const mark of document.querySelectorAll(HIGHLIGHT_SELECTOR)) {
      const parent = mark.parentNode;
      if (!parent) {
        continue;
      }
      parents.add(parent);
      parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
    }
    for (const parent of parents) {
      parent.normalize();
    }
  }

  function highlightRoot(root) {
    if (!settings.enabled || !matcher || !root) {
      return;
    }

    if (root.nodeType === Node.TEXT_NODE) {
      highlightTextNode(root);
      return;
    }

    if (![Node.ELEMENT_NODE, Node.DOCUMENT_FRAGMENT_NODE].includes(root.nodeType)) {
      return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => isEligibleTextNode(node)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT
    });
    const nodes = [];
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }
    for (const node of nodes) {
      highlightTextNode(node);
    }
  }

  function isEligibleTextNode(node) {
    if (!node.nodeValue || !node.nodeValue.trim()) {
      return false;
    }

    const parent = node.parentElement;
    if (!parent || parent.closest(HIGHLIGHT_SELECTOR) || parent.closest(EXCLUDED_SELECTOR)) {
      return false;
    }

    return !ui.host.contains(parent);
  }

  function highlightTextNode(node) {
    const text = node.nodeValue;
    matcher.lastIndex = 0;
    let match = matcher.exec(text);
    if (!match) {
      return;
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;

    while (match) {
      const prefix = match[1] || "";
      const matchedWord = match[2];
      const wordStart = match.index + prefix.length;
      const key = normalizeKey(matchedWord);

      fragment.append(document.createTextNode(text.slice(cursor, wordStart)));
      const mark = document.createElement("mark");
      mark.className = "sl-word-highlight";
      mark.dataset.vocabWord = key;
      mark.textContent = matchedWord;
      mark.setAttribute("aria-label", `${matchedWord}，点击查看中文翻译`);
      applyHighlightColor(mark);
      fragment.append(mark);
      cursor = wordStart + matchedWord.length;

      matcher.lastIndex = cursor;
      match = matcher.exec(text);
    }

    fragment.append(document.createTextNode(text.slice(cursor)));
    node.parentNode?.replaceChild(fragment, node);
  }

  function startObserver() {
    if (observer || !document.documentElement) {
      return;
    }

    observer = new MutationObserver((mutations) => {
      if (!settings.enabled || !matcher) {
        pendingRoots.clear();
        return;
      }

      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          pendingRoots.add(mutation.target);
        }
        for (const node of mutation.addedNodes) {
          if (node !== ui.host && !ui.host.contains(node)) {
            pendingRoots.add(node);
          }
        }
      }
      scheduleMutationPass();
    });
    observeDocument();
  }

  function applyHighlightColor(mark) {
    const { red, green, blue } = getHighlightRgb(settings.highlightColor);
    mark.style.setProperty("--sl-highlight-rgb", `${red} ${green} ${blue}`, "important");
  }

  function applyHighlightColorToAll() {
    for (const mark of document.querySelectorAll(HIGHLIGHT_SELECTOR)) {
      applyHighlightColor(mark);
    }
  }

  function observeDocument() {
    observer?.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  function scheduleMutationPass() {
    if (!settings.enabled || !matcher || pendingRoots.size === 0) {
      return;
    }

    window.clearTimeout(mutationTimer);
    mutationTimer = window.setTimeout(() => {
      const roots = Array.from(pendingRoots);
      pendingRoots.clear();
      withObserverPaused(() => {
        for (const root of roots) {
          if (root.isConnected) {
            highlightRoot(root);
          }
        }
      });
    }, 90);
  }

  function withObserverPaused(callback) {
    observer?.disconnect();
    try {
      callback();
    } finally {
      if (observer && document.documentElement) {
        observeDocument();
      }
    }
  }

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
  }

  function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
  }
})();

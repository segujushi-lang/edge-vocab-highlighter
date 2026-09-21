(function startPopup() {
  "use strict";

  const {
    STORAGE_KEYS,
    DEFAULT_HIGHLIGHT_COLOR,
    DEFAULT_SETTINGS,
    cleanWord,
    isValidWord,
    normalizeKey,
    sanitizeEntries,
    normalizeHighlightColor,
    sanitizeSettings,
    getHighlightRgb
  } = globalThis.VocabGlowUtils;

  let entries = {};
  let settings = { ...DEFAULT_SETTINGS };
  let noticeTimer = 0;

  const elements = {
    enabledToggle: document.getElementById("enabledToggle"),
    highlightColorInput: document.getElementById("highlightColorInput"),
    highlightColorValue: document.getElementById("highlightColorValue"),
    highlightPreview: document.getElementById("highlightPreview"),
    resetColorButton: document.getElementById("resetColorButton"),
    addForm: document.getElementById("addForm"),
    addButton: document.getElementById("addButton"),
    wordInput: document.getElementById("wordInput"),
    translationInput: document.getElementById("translationInput"),
    searchInput: document.getElementById("searchInput"),
    wordCount: document.getElementById("wordCount"),
    wordList: document.getElementById("wordList"),
    emptyState: document.getElementById("emptyState"),
    noResultState: document.getElementById("noResultState"),
    highlightStatus: document.getElementById("highlightStatus"),
    clearButton: document.getElementById("clearButton"),
    notice: document.getElementById("notice")
  };

  elements.addForm.addEventListener("submit", (event) => void handleAdd(event));
  elements.enabledToggle.addEventListener("change", () => void handleToggle());
  elements.highlightColorInput.addEventListener("input", handleColorPreview);
  elements.highlightColorInput.addEventListener("change", () => void handleColorChange());
  elements.resetColorButton.addEventListener("click", () => void handleColorReset());
  elements.searchInput.addEventListener("input", render);
  elements.wordList.addEventListener("click", (event) => void handleListClick(event));
  elements.clearButton.addEventListener("click", () => void handleClear());
  chrome.storage.onChanged.addListener(handleStorageChange);

  void loadState();

  async function loadState() {
    try {
      const response = await sendMessage({ type: "GET_STATE" });
      if (!response.ok) {
        throw new Error(response.error || "读取词库失败");
      }
      entries = sanitizeEntries(response.entries);
      settings = sanitizeSettings(response.settings);
      render();
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "读取词库失败", "error");
    }
  }

  async function handleAdd(event) {
    event.preventDefault();
    const word = cleanWord(elements.wordInput.value);
    const translation = elements.translationInput.value.trim();
    if (!isValidWord(word)) {
      showNotice("请输入一个完整的英文单词", "error");
      elements.wordInput.focus();
      return;
    }

    elements.addButton.disabled = true;
    try {
      const response = await sendMessage({ type: "ADD_WORD", word, translation });
      if (!response.ok) {
        throw new Error(response.error || "添加失败");
      }
      elements.addForm.reset();
      elements.wordInput.focus();
      const detail = response.entry?.translation ? `已保存：${response.entry.translation}` : "已保存，可稍后补充翻译";
      showNotice(`${word} ${detail}`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "添加失败", "error");
    } finally {
      elements.addButton.disabled = false;
    }
  }

  async function handleToggle() {
    const enabled = elements.enabledToggle.checked;
    elements.enabledToggle.disabled = true;
    try {
      const response = await sendMessage({ type: "SET_ENABLED", enabled });
      if (!response.ok) {
        throw new Error(response.error || "设置失败");
      }
      settings = response.settings;
      renderStatus();
      showNotice(enabled ? "网页高亮已开启" : "网页高亮已暂停");
    } catch (error) {
      elements.enabledToggle.checked = !enabled;
      showNotice(error instanceof Error ? error.message : "设置失败", "error");
    } finally {
      elements.enabledToggle.disabled = false;
    }
  }

  function handleColorPreview() {
    renderColorPreview(elements.highlightColorInput.value);
  }

  async function handleColorChange() {
    await saveHighlightColor(elements.highlightColorInput.value, "高亮颜色已更新");
  }

  async function handleColorReset() {
    await saveHighlightColor(DEFAULT_HIGHLIGHT_COLOR, "已恢复默认高亮颜色");
  }

  async function saveHighlightColor(highlightColor, successMessage) {
    const previousColor = settings.highlightColor;
    elements.highlightColorInput.disabled = true;
    elements.resetColorButton.disabled = true;
    try {
      const response = await sendMessage({ type: "SET_HIGHLIGHT_COLOR", highlightColor });
      if (!response.ok) {
        throw new Error(response.error || "颜色设置失败");
      }
      settings = sanitizeSettings(response.settings);
      renderColorSetting();
      showNotice(successMessage);
    } catch (error) {
      settings = sanitizeSettings({ ...settings, highlightColor: previousColor });
      renderColorSetting();
      showNotice(error instanceof Error ? error.message : "颜色设置失败", "error");
    } finally {
      elements.highlightColorInput.disabled = false;
      elements.resetColorButton.disabled = settings.highlightColor === DEFAULT_HIGHLIGHT_COLOR;
    }
  }

  async function handleListClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    const item = button.closest(".word-item");
    const key = item?.dataset.key || "";
    const entry = entries[key];
    if (!entry) {
      return;
    }

    const action = button.dataset.action;
    if (action === "edit") {
      item.querySelector(".edit-panel")?.classList.remove("hidden");
      const input = item.querySelector(".edit-input");
      input?.focus();
      input?.select();
      return;
    }

    if (action === "cancel") {
      item.querySelector(".edit-panel")?.classList.add("hidden");
      return;
    }

    button.disabled = true;
    try {
      if (action === "delete") {
        const response = await sendMessage({ type: "REMOVE_WORD", key });
        if (!response.ok) {
          throw new Error(response.error || "删除失败");
        }
        showNotice(`${entry.word} 已移出词库`);
      } else if (action === "retry") {
        const response = await sendMessage({ type: "RETRY_TRANSLATION", key });
        if (!response.ok) {
          throw new Error(response.error || "翻译失败");
        }
        showNotice(response.entry?.translation ? `翻译完成：${response.entry.translation}` : "仍未找到合适的翻译");
      } else if (action === "save") {
        const translation = item.querySelector(".edit-input")?.value.trim() || "";
        const response = await sendMessage({ type: "UPDATE_TRANSLATION", key, translation });
        if (!response.ok) {
          throw new Error(response.error || "保存失败");
        }
        showNotice(`${entry.word} 的翻译已更新`);
      }
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "操作失败", "error");
      button.disabled = false;
    }
  }

  async function handleClear() {
    const count = Object.keys(entries).length;
    if (count === 0 || !window.confirm(`确定清空全部 ${count} 个生词吗？`)) {
      return;
    }

    elements.clearButton.disabled = true;
    try {
      const response = await sendMessage({ type: "CLEAR_WORDS" });
      if (!response.ok) {
        throw new Error(response.error || "清空失败");
      }
      showNotice("词库已清空");
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "清空失败", "error");
    } finally {
      elements.clearButton.disabled = false;
    }
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local") {
      return;
    }
    if (changes[STORAGE_KEYS.entries]) {
      entries = sanitizeEntries(changes[STORAGE_KEYS.entries].newValue);
    }
    if (changes[STORAGE_KEYS.settings]) {
      settings = sanitizeSettings(changes[STORAGE_KEYS.settings].newValue);
    }
    render();
  }

  function render() {
    const allEntries = Object.values(entries).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const query = elements.searchInput.value.trim().toLocaleLowerCase("zh-CN");
    const visibleEntries = query
      ? allEntries.filter((entry) => `${entry.word} ${entry.translation}`.toLocaleLowerCase("zh-CN").includes(query))
      : allEntries;

    elements.wordCount.textContent = String(allEntries.length);
    elements.wordList.replaceChildren(...visibleEntries.map(createWordItem));
    elements.emptyState.classList.toggle("hidden", allEntries.length !== 0);
    elements.noResultState.classList.toggle("hidden", allEntries.length === 0 || visibleEntries.length !== 0);
    elements.wordList.classList.toggle("hidden", visibleEntries.length === 0);
    elements.clearButton.disabled = allEntries.length === 0;
    renderStatus();
    renderColorSetting();
  }

  function renderStatus() {
    elements.enabledToggle.checked = Boolean(settings.enabled);
    elements.highlightStatus.textContent = settings.enabled ? "网页高亮已开启" : "网页高亮已暂停";
  }

  function renderColorSetting() {
    const highlightColor = normalizeHighlightColor(settings.highlightColor);
    elements.highlightColorInput.value = highlightColor;
    elements.resetColorButton.disabled = highlightColor === DEFAULT_HIGHLIGHT_COLOR;
    renderColorPreview(highlightColor);
  }

  function renderColorPreview(highlightColor) {
    const color = normalizeHighlightColor(highlightColor);
    const { red, green, blue } = getHighlightRgb(color);
    elements.highlightColorValue.textContent = color.toLocaleUpperCase("en-US");
    elements.highlightPreview.style.setProperty("--preview-rgb", `${red} ${green} ${blue}`);
  }

  function createWordItem(entry) {
    const item = document.createElement("article");
    item.className = "word-item";
    item.dataset.key = entry.key;
    item.innerHTML = `
      <div class="word-top">
        <div class="word-copy">
          <h3 class="word-name"></h3>
          <p class="word-translation"></p>
        </div>
        <div class="word-actions">
          <button class="icon-button retry-button hidden" data-action="retry" type="button" title="重试翻译" aria-label="重试翻译">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 11a8 8 0 1 0-2.34 5.66"></path><path d="M20 4v7h-7"></path></svg>
          </button>
          <button class="icon-button" data-action="edit" type="button" title="修改翻译" aria-label="修改翻译">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
          </button>
          <button class="icon-button danger" data-action="delete" type="button" title="移出词库" aria-label="移出词库">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 15H6L5 6"></path></svg>
          </button>
        </div>
      </div>
      <p class="word-meta"></p>
      <div class="edit-panel hidden">
        <input class="edit-input" type="text" maxlength="240" aria-label="中文翻译">
        <button class="mini-button" data-action="save" type="button">保存</button>
        <button class="mini-button secondary" data-action="cancel" type="button">取消</button>
      </div>
    `;

    item.querySelector(".word-name").textContent = entry.word;
    const translationElement = item.querySelector(".word-translation");
    const retryButton = item.querySelector(".retry-button");
    if (entry.translationStatus === "loading") {
      translationElement.textContent = "正在获取中文翻译…";
      translationElement.classList.add("loading");
    } else if (entry.translation) {
      translationElement.textContent = entry.translation;
    } else {
      translationElement.textContent = "未获取到翻译，可手工补充";
      translationElement.classList.add("error");
      retryButton.classList.remove("hidden");
    }
    item.querySelector(".word-meta").textContent = `更新于 ${formatDate(entry.updatedAt)}`;
    item.querySelector(".edit-input").value = entry.translation;
    return item;
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "刚刚";
    }
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function showNotice(message, variant = "default") {
    window.clearTimeout(noticeTimer);
    elements.notice.textContent = message;
    elements.notice.className = `notice ${variant === "error" ? "error" : ""}`.trim();
    elements.notice.classList.remove("hidden");
    noticeTimer = window.setTimeout(() => elements.notice.classList.add("hidden"), 2300);
  }

  function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
  }
})();

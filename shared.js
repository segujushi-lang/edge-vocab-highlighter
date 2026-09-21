(function initShared(global) {
  "use strict";

  const STORAGE_KEYS = Object.freeze({
    entries: "vocabEntries",
    settings: "vocabSettings",
    history: "vocabActionHistory"
  });

  const DEFAULT_HIGHLIGHT_COLOR = "#ffdd57";
  const MAX_IMPORT_WORDS = 500;
  const MAX_IMPORT_FILE_BYTES = 1024 * 1024;

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    highlightColor: DEFAULT_HIGHLIGHT_COLOR
  });

  const WORD_PATTERN = /^[A-Za-z]+(?:['-][A-Za-z]+)*$/;
  const HAN_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/;
  const HEX_COLOR_PATTERN = /^#[\da-f]{6}$/i;

  function cleanWord(value) {
    if (typeof value !== "string") {
      return "";
    }

    return value
      .normalize("NFKC")
      .replace(/[‘’]/g, "'")
      .replace(/[‐‑‒–—]/g, "-")
      .trim();
  }

  function isValidWord(value) {
    const word = cleanWord(value);
    return word.length > 0 && word.length <= 64 && WORD_PATTERN.test(word);
  }

  function normalizeKey(value) {
    const word = cleanWord(value);
    return isValidWord(word) ? word.toLocaleLowerCase("en-US") : "";
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildWordMatcher(keys) {
    const words = Array.from(new Set(keys.map(normalizeKey).filter(Boolean)))
      .sort((left, right) => right.length - left.length);

    if (words.length === 0) {
      return null;
    }

    const alternatives = words.map(escapeRegExp).join("|");
    return new RegExp(`(^|[^A-Za-z])(${alternatives})(?=$|[^A-Za-z])`, "gi");
  }

  function sanitizeEntries(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }

    const sanitized = {};
    for (const entry of Object.values(value)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const key = normalizeKey(entry.key || entry.word);
      if (!key) {
        continue;
      }

      sanitized[key] = {
        key,
        word: cleanWord(entry.word) || key,
        translation: typeof entry.translation === "string" ? entry.translation.trim() : "",
        translationStatus: ["loading", "ready", "error"].includes(entry.translationStatus)
          ? entry.translationStatus
          : entry.translation
            ? "ready"
            : "error",
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date(0).toISOString(),
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString(),
        sourceUrl: typeof entry.sourceUrl === "string" ? entry.sourceUrl : "",
        translationRequestId: typeof entry.translationRequestId === "string"
          ? entry.translationRequestId
          : ""
      };
    }

    return sanitized;
  }

  function isValidHighlightColor(value) {
    return typeof value === "string" && HEX_COLOR_PATTERN.test(value.trim());
  }

  function normalizeHighlightColor(value) {
    return isValidHighlightColor(value)
      ? value.trim().toLocaleLowerCase("en-US")
      : DEFAULT_HIGHLIGHT_COLOR;
  }

  function sanitizeSettings(value) {
    const stored = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
      enabled: typeof stored.enabled === "boolean" ? stored.enabled : DEFAULT_SETTINGS.enabled,
      highlightColor: normalizeHighlightColor(stored.highlightColor)
    };
  }

  function getHighlightRgb(value) {
    const color = normalizeHighlightColor(value);
    return {
      red: Number.parseInt(color.slice(1, 3), 16),
      green: Number.parseInt(color.slice(3, 5), 16),
      blue: Number.parseInt(color.slice(5, 7), 16)
    };
  }

  function summarizeHistory(value) {
    if (value && typeof value === "object" && typeof value.canUndo === "boolean") {
      return {
        canUndo: value.canUndo,
        canRedo: Boolean(value.canRedo),
        undoLabel: typeof value.undoLabel === "string" ? value.undoLabel : "",
        redoLabel: typeof value.redoLabel === "string" ? value.redoLabel : ""
      };
    }

    const undo = value && Array.isArray(value.undo) ? value.undo : [];
    const redo = value && Array.isArray(value.redo) ? value.redo : [];
    const undoLabel = undo.at(-1)?.description;
    const redoLabel = redo.at(-1)?.description;
    return {
      canUndo: undo.length > 0,
      canRedo: redo.length > 0,
      undoLabel: typeof undoLabel === "string" ? undoLabel : "",
      redoLabel: typeof redoLabel === "string" ? redoLabel : ""
    };
  }

  function parseWordImportText(value, limit = MAX_IMPORT_WORDS) {
    const text = typeof value === "string" ? value.replace(/^\uFEFF/, "") : "";
    const maximum = Number.isInteger(limit) && limit > 0 ? limit : MAX_IMPORT_WORDS;
    const itemsByKey = new Map();
    const invalidLineNumbers = [];
    let invalidCount = 0;
    let duplicateCount = 0;
    let ignoredCount = 0;
    let overLimitCount = 0;
    let insideCodeFence = false;

    const lines = text.split(/\r\n|\n|\r/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (/^(?:```|~~~)/.test(line)) {
        insideCodeFence = !insideCodeFence;
        ignoredCount += 1;
        continue;
      }
      if (
        !line
        || insideCodeFence
        || line.startsWith("#")
        || /^<!--.*-->$/.test(line)
        || /^(?:-{3,}|\*{3,}|_{3,})$/.test(line)
      ) {
        ignoredCount += 1;
        continue;
      }

      const parsed = parseImportLine(line);
      if (parsed.ignored) {
        ignoredCount += 1;
        continue;
      }

      const word = cleanWord(parsed.word);
      const translation = parsed.translation.trim().slice(0, 240);
      const key = normalizeKey(word);

      if (!key) {
        invalidCount += 1;
        if (invalidLineNumbers.length < 8) {
          invalidLineNumbers.push(index + 1);
        }
        continue;
      }

      const existing = itemsByKey.get(key);
      if (existing) {
        duplicateCount += 1;
        if (!existing.translation && translation) {
          existing.translation = translation;
        }
        continue;
      }

      if (itemsByKey.size >= maximum) {
        overLimitCount += 1;
        continue;
      }

      itemsByKey.set(key, { word, translation });
    }

    return {
      items: Array.from(itemsByKey.values()),
      invalidCount,
      invalidLineNumbers,
      duplicateCount,
      ignoredCount,
      overLimitCount
    };
  }

  function parseImportLine(value) {
    const tableCells = parseMarkdownTableCells(value);
    if (tableCells) {
      if (tableCells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
        return { ignored: true, word: "", translation: "" };
      }

      const word = unwrapMarkdownToken(tableCells[0]);
      if (/^(?:word|english|单词|英文)$/i.test(word)) {
        return { ignored: true, word: "", translation: "" };
      }
      return {
        ignored: false,
        word,
        translation: unwrapMarkdownToken(tableCells[1] || "")
      };
    }

    const line = value
      .replace(/^(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/, "")
      .trim();
    if (!line) {
      return { ignored: true, word: "", translation: "" };
    }

    const normalizedLine = line.replace(
      /^(\*\*|__|`|\*|_)([A-Za-z]+(?:['’\-][A-Za-z]+)*)\1/,
      "$2"
    );
    const matched = normalizedLine.match(
      /^([A-Za-z]+(?:['’\-][A-Za-z]+)*)(?:\t+|\s*[,，=:：]\s*|\s+(?:=>|->|[-–—])\s+)(.*)$/
    );
    if (matched) {
      return {
        ignored: false,
        word: unwrapMarkdownToken(matched[1]),
        translation: unwrapMarkdownToken(matched[2])
      };
    }

    return { ignored: false, word: unwrapMarkdownToken(normalizedLine), translation: "" };
  }

  function parseMarkdownTableCells(value) {
    if (!value.includes("|")) {
      return null;
    }

    const cells = value
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    return cells.length >= 2 ? cells : null;
  }

  function unwrapMarkdownToken(value) {
    let token = typeof value === "string" ? value.trim() : "";
    const wrappers = [["**", "**"], ["__", "__"], ["`", "`"], ["*", "*"], ["_", "_"]];
    for (const [start, end] of wrappers) {
      if (token.startsWith(start) && token.endsWith(end) && token.length > start.length + end.length) {
        token = token.slice(start.length, -end.length).trim();
        break;
      }
    }
    return token;
  }

  function decodeHtmlEntities(value) {
    if (typeof value !== "string") {
      return "";
    }

    const named = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      quot: "\""
    };

    return value
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
      .replace(/&(amp|apos|gt|lt|quot);/g, (_, name) => named[name]);
  }

  function hasChineseText(value) {
    return typeof value === "string" && HAN_PATTERN.test(value);
  }

  global.VocabGlowUtils = Object.freeze({
    STORAGE_KEYS,
    DEFAULT_HIGHLIGHT_COLOR,
    DEFAULT_SETTINGS,
    MAX_IMPORT_WORDS,
    MAX_IMPORT_FILE_BYTES,
    cleanWord,
    isValidWord,
    normalizeKey,
    escapeRegExp,
    buildWordMatcher,
    sanitizeEntries,
    isValidHighlightColor,
    normalizeHighlightColor,
    sanitizeSettings,
    getHighlightRgb,
    summarizeHistory,
    parseWordImportText,
    decodeHtmlEntities,
    hasChineseText
  });
})(globalThis);

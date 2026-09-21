(function initShared(global) {
  "use strict";

  const STORAGE_KEYS = Object.freeze({
    entries: "vocabEntries",
    settings: "vocabSettings"
  });

  const DEFAULT_HIGHLIGHT_COLOR = "#ffdd57";

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
    decodeHtmlEntities,
    hasChineseText
  });
})(globalThis);

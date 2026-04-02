// ==UserScript==
// @name         GitHub Interface Translator (Chinese)
// @namespace    https://greasyfork.org/
// @version      0.5.0
// @description  Translate most GitHub page text to Chinese while keeping file/folder names and code sections untouched.
// @author       You
// @match        https://github.com/*
// @grant        GM_xmlhttpRequest
// @connect      translate.googleapis.com
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const TARGET_LANG = 'zh-CN';
  const BUTTON_ID = 'gh-interface-translate-btn';
  const TRANSLATE_LABEL = '翻译页面';
  const RESTORE_LABEL = '恢复原文';
  const PROCESSING_LABEL = '翻译中...';

  const MAX_TEXT_LENGTH = 700;
  const MAX_NODES_PER_PASS = 2500;
  const APPLY_BATCH_SIZE = 120;
  const CONCURRENCY = 8;
  const BATCH_CONCURRENCY = 4;
  const BATCH_MAX_ITEMS = 80;
  const BATCH_MAX_CHARS = 12000;
  const DYNAMIC_TRANSLATE_DEBOUNCE_MS = 800;
  const MAX_PENDING_ROOTS = 200;
  const ENABLE_DYNAMIC_TRANSLATE = true;
  const BATCH_MARKER_PREFIX = '[[[GHTR_SPLIT_';
  const BATCH_MARKER_SUFFIX = ']]]';
  const CACHE_STORAGE_KEY = 'gh_interface_translator_cache_v2';
  const CACHE_MAX_ENTRIES = 4000;

  const SKIP_CONTAINER_SELECTOR = [
    'pre',
    'code',
    'textarea',
    'script',
    'style',
    'svg',
    'math',
    '.highlight',
    '.blob-code',
    '.blob-code-inner',
    '.react-code-text',
    '.js-file-line-container',
    '.notranslate',
    '.octicon',
    '.anchor',
    '.clipboard-copy',
    '.js-navigation-container',
    '.js-navigation-open',
    'table.files',
    '.react-directory-row',
    '.react-directory-filename-column',
    '.react-directory-filename-cell',
    '.file-navigation',
    '.breadcrumb',
    '[aria-labelledby="folders-and-files"]',
    '[aria-label="Repository files"]',
    '[data-testid="tree-list"]',
    '[data-testid="tree-item-file-name"]',
    '[data-testid="tree-item-directory-name"]',
  ].join(', ');

  const translatedNodes = new Map();
  const translationCache = new Map();

  const pendingRoots = new Set();

  let isTranslated = false;
  let isProcessing = false;
  let lastRouteKey = '';
  let dynamicTranslateTimer = null;
  let dynamicObserver = null;
  let historyHooked = false;
  let cachePersistTimer = null;

  function getRequestFn() {
    if (typeof GM_xmlhttpRequest === 'function') {
      return GM_xmlhttpRequest;
    }
    if (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function') {
      return GM.xmlHttpRequest.bind(GM);
    }
    return null;
  }

  const gmRequest = getRequestFn();

  function setCachedTranslation(key, value) {
    if (!key || !value) return;
    if (translationCache.has(key)) {
      translationCache.delete(key);
    }
    translationCache.set(key, value);
    schedulePersistCache();
  }

  function schedulePersistCache() {
    clearTimeout(cachePersistTimer);
    cachePersistTimer = setTimeout(() => {
      try {
        const entries = Array.from(translationCache.entries());
        const trimmed = entries.slice(-CACHE_MAX_ENTRIES);
        localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(trimmed));
      } catch (error) {
        // Ignore localStorage quota/access errors.
      }
    }, 1200);
  }

  function loadPersistedCache() {
    try {
      const raw = localStorage.getItem(CACHE_STORAGE_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;

      for (const pair of parsed) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const [key, value] = pair;
        if (typeof key === 'string' && typeof value === 'string') {
          translationCache.set(key, value);
        }
      }
    } catch (error) {
      // Ignore malformed cache payload.
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function splitEdgeWhitespace(text) {
    const match = (text || '').match(/^(\s*)([\s\S]*?)(\s*)$/);
    return {
      lead: match ? match[1] : '',
      core: match ? match[2] : '',
      tail: match ? match[3] : '',
    };
  }

  function normalizeKey(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function looksLikeFilename(text) {
    const trimmed = normalizeKey(text);
    if (!trimmed || trimmed.length > 120) return false;

    if (/^[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,10}$/.test(trimmed)) return true;
    if (/^[./~A-Za-z0-9_-]+\/[./~A-Za-z0-9_-]+/.test(trimmed)) return true;
    if (/^\.{1,2}$/.test(trimmed)) return true;

    return false;
  }

  function isSkippableText(text) {
    const trimmed = normalizeKey(text);
    if (!trimmed) return true;
    if (trimmed.length < 2) return true;
    if (trimmed.length > MAX_TEXT_LENGTH) return true;

    if (/^[\d\s.,:;()[\]{}'"`~!@#$%^&*+=<>|\\/-]+$/.test(trimmed)) {
      return true;
    }

    if (!/[A-Za-z\u00C0-\u024F\u0400-\u04FF]/.test(trimmed)) {
      return true;
    }

    return false;
  }

  function shouldSkipNode(node) {
    const parent = node.parentElement;
    if (!parent) return true;

    if (parent.closest(SKIP_CONTAINER_SELECTOR)) return true;
    if (parent.closest('[hidden], [aria-hidden="true"]')) return true;

    const text = node.nodeValue || '';
    if (parent.closest('a[href], button, [role="menuitem"], summary') && looksLikeFilename(text)) {
      return true;
    }

    return isSkippableText(text);
  }

  function getTranslationRoots() {
    const roots = [
      document.querySelector('main'),
      document.querySelector('[role="main"]'),
      document.querySelector('#repo-content-pjax-container'),
      document.querySelector('[data-testid="repository-sidebar"]'),
      document.querySelector('.Layout-sidebar'),
    ].filter(Boolean);

    if (!roots.length && document.body) {
      roots.push(document.body);
    }

    return Array.from(new Set(roots));
  }

  function collectTranslatableTextNodes(root, onlyUntranslated) {
    if (!root) return [];

    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (shouldSkipNode(node)) return NodeFilter.FILTER_REJECT;
        if (onlyUntranslated && translatedNodes.has(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let current = walker.nextNode();
    while (current) {
      nodes.push(current);
      if (nodes.length >= MAX_NODES_PER_PASS) break;
      current = walker.nextNode();
    }

    return nodes;
  }

  function normalizeTranslatedText(data) {
    if (!Array.isArray(data) || !Array.isArray(data[0])) return '';
    return data[0].map((item) => (item && item[0] ? item[0] : '')).join('');
  }

  function requestSingleTranslate(textKey) {
    return new Promise((resolve) => {
      if (!gmRequest) {
        resolve(null);
        return;
      }

      const cached = translationCache.get(textKey);
      if (cached) {
        resolve(cached);
        return;
      }

      const url =
        'https://translate.googleapis.com/translate_a/single' +
        `?client=gtx&sl=auto&tl=${encodeURIComponent(TARGET_LANG)}&dt=t&q=${encodeURIComponent(textKey)}`;

      gmRequest({
        method: 'GET',
        url,
        timeout: 12000,
        onload(response) {
          try {
            const payload = JSON.parse(response.responseText);
            const translated = normalizeTranslatedText(payload).trim() || textKey;
            setCachedTranslation(textKey, translated);
            resolve(translated);
          } catch (error) {
            resolve(null);
          }
        },
        ontimeout() {
          resolve(null);
        },
        onerror() {
          resolve(null);
        },
      });
    });
  }

  function splitIntoBatches(keys) {
    const batches = [];
    let current = [];
    let currentChars = 0;

    for (const key of keys) {
      const estimated = key.length + 32;
      const willOverflow =
        current.length >= BATCH_MAX_ITEMS || currentChars + estimated > BATCH_MAX_CHARS;

      if (current.length && willOverflow) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }

      current.push(key);
      currentChars += estimated;
    }

    if (current.length) {
      batches.push(current);
    }

    return batches;
  }

  function buildBatchPayload(keys) {
    return keys
      .map((text, index) => `${BATCH_MARKER_PREFIX}${index}${BATCH_MARKER_SUFFIX}\n${text}`)
      .join('\n\n');
  }

  function parseBatchResultText(text, expectedCount) {
    if (!text) return null;

    const markerRegex = /\[\[\[GHTR_SPLIT_(\d+)]]]/g;
    const markers = [];
    let match = markerRegex.exec(text);
    while (match) {
      markers.push({
        index: Number(match[1]),
        start: match.index,
        end: markerRegex.lastIndex,
      });
      match = markerRegex.exec(text);
    }

    if (markers.length !== expectedCount) {
      return null;
    }

    const seen = new Set(markers.map((item) => item.index));
    if (seen.size !== expectedCount) {
      return null;
    }

    const result = new Array(expectedCount).fill('');
    for (let i = 0; i < markers.length; i += 1) {
      const current = markers[i];
      const next = markers[i + 1];
      if (current.index < 0 || current.index >= expectedCount) {
        return null;
      }

      const segment = text
        .slice(current.end, next ? next.start : text.length)
        .replace(/^\s+/, '')
        .replace(/\s+$/, '');

      result[current.index] = segment;
    }

    if (result.some((item) => item === '')) {
      return null;
    }

    return result;
  }

  function requestBatchTranslate(keys) {
    return new Promise((resolve) => {
      if (!gmRequest || !keys.length) {
        resolve(null);
        return;
      }

      const payload = buildBatchPayload(keys);
      const url = 'https://translate.googleapis.com/translate_a/single';
      const params = new URLSearchParams();
      params.set('client', 'gtx');
      params.set('sl', 'auto');
      params.set('tl', TARGET_LANG);
      params.set('dt', 't');
      params.set('q', payload);

      gmRequest({
        method: 'POST',
        url,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        data: params.toString(),
        timeout: 12000,
        onload(response) {
          try {
            const parsed = JSON.parse(response.responseText);
            const translatedPayload = normalizeTranslatedText(parsed);
            const segments = parseBatchResultText(translatedPayload, keys.length);
            resolve(segments);
          } catch (error) {
            resolve(null);
          }
        },
        ontimeout() {
          resolve(null);
        },
        onerror() {
          resolve(null);
        },
      });
    });
  }

  async function requestTranslations(keys) {
    const translationMap = new Map();
    const uncached = [];

    for (const key of keys) {
      const cached = translationCache.get(key);
      if (cached) {
        translationMap.set(key, cached);
      } else {
        uncached.push(key);
      }
    }

    if (!uncached.length) {
      return translationMap;
    }

    const batches = splitIntoBatches(uncached);
    await mapWithConcurrency(batches, BATCH_CONCURRENCY, async (batch) => {
      const batched = await requestBatchTranslate(batch);
      if (batched && batched.length === batch.length) {
        for (let i = 0; i < batch.length; i += 1) {
          const key = batch[i];
          const translated = batched[i] || key;
          setCachedTranslation(key, translated);
          translationMap.set(key, translated);
        }
        return;
      }

      await mapWithConcurrency(batch, CONCURRENCY, async (key) => {
        const translated = await requestSingleTranslate(key);
        if (translated) {
          setCachedTranslation(key, translated);
          translationMap.set(key, translated);
        } else {
          translationMap.set(key, key);
        }
      });
    });

    return translationMap;
  }

  async function mapWithConcurrency(items, limit, worker) {
    if (!items.length) return;

    let index = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const current = index;
        index += 1;
        await worker(items[current]);
      }
    });

    await Promise.all(workers);
  }

  async function translateNodes(nodes) {
    if (!nodes.length || isProcessing) return;

    isProcessing = true;
    updateButtonLabel();

    try {
      const uniqueTextKeys = new Set();

      for (const node of nodes) {
        if (!translatedNodes.has(node)) {
          translatedNodes.set(node, node.nodeValue || '');
        }

        const original = translatedNodes.get(node) || '';
        const key = normalizeKey(splitEdgeWhitespace(original).core);
        if (!isSkippableText(key)) {
          uniqueTextKeys.add(key);
        }
      }

      const translationMap = await requestTranslations(Array.from(uniqueTextKeys));

      for (let i = 0; i < nodes.length; i += APPLY_BATCH_SIZE) {
        const batch = nodes.slice(i, i + APPLY_BATCH_SIZE);
        for (const node of batch) {
          if (!node.isConnected) continue;

          const original = translatedNodes.get(node) || '';
          const parts = splitEdgeWhitespace(original);
          const key = normalizeKey(parts.core);
          const translated = translationMap.get(key);
          if (!translated) continue;

          node.nodeValue = `${parts.lead}${translated}${parts.tail}`;
        }
        await sleep(0);
      }

      isTranslated = true;
    } finally {
      isProcessing = false;
      updateButtonLabel();
    }
  }

  async function translatePage() {
    const roots = getTranslationRoots();
    if (!roots.length) return;

    const merged = new Set();
    for (const root of roots) {
      const nodes = collectTranslatableTextNodes(root, false);
      for (const node of nodes) {
        merged.add(node);
      }
    }

    await translateNodes(Array.from(merged));
  }

  async function translatePendingRoots() {
    if (!isTranslated || isProcessing || pendingRoots.size === 0) return;

    const roots = Array.from(pendingRoots);
    pendingRoots.clear();

    const merged = new Set();
    const translationRoots = getTranslationRoots();
    for (const root of roots) {
      if (!root || !root.isConnected) continue;

      const scanRoot = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
      if (!scanRoot) continue;
      if (
        translationRoots.length &&
        !translationRoots.some((translationRoot) => translationRoot.contains(scanRoot))
      ) {
        continue;
      }

      const nodes = collectTranslatableTextNodes(scanRoot, true);
      for (const node of nodes) {
        merged.add(node);
      }
    }

    await translateNodes(Array.from(merged));
  }

  function restoreOriginalText() {
    for (const [node, original] of translatedNodes.entries()) {
      if (node.isConnected) {
        node.nodeValue = original;
      }
    }

    pendingRoots.clear();
    isTranslated = false;
    stopDynamicObserver();
    updateButtonLabel();
  }

  function updateButtonLabel() {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;

    if (isProcessing) {
      btn.textContent = PROCESSING_LABEL;
      btn.disabled = true;
      return;
    }

    btn.textContent = isTranslated ? RESTORE_LABEL : TRANSLATE_LABEL;
    btn.disabled = false;
  }

  function startDynamicObserver() {
    if (!ENABLE_DYNAMIC_TRANSLATE) return;
    if (dynamicObserver) return;
    const roots = getTranslationRoots();
    if (!roots.length) return;

    dynamicObserver = new MutationObserver((mutationList) => {
      if (!isTranslated || isProcessing) return;

      let reachedCap = false;
      for (const mutation of mutationList) {
        for (const added of mutation.addedNodes) {
          if (added.nodeType === Node.ELEMENT_NODE || added.nodeType === Node.TEXT_NODE) {
            pendingRoots.add(added);
            if (pendingRoots.size >= MAX_PENDING_ROOTS) {
              reachedCap = true;
              break;
            }
          }
        }
        if (reachedCap) break;
      }

      if (reachedCap) {
        pendingRoots.clear();
        const roots = getTranslationRoots();
        for (const root of roots) {
          pendingRoots.add(root);
        }
      }

      if (pendingRoots.size === 0) return;

      clearTimeout(dynamicTranslateTimer);
      dynamicTranslateTimer = setTimeout(() => {
        translatePendingRoots().catch(() => {});
      }, DYNAMIC_TRANSLATE_DEBOUNCE_MS);
    });

    for (const root of roots) {
      dynamicObserver.observe(root, {
        childList: true,
        subtree: true,
      });
    }
  }

  function stopDynamicObserver() {
    if (dynamicObserver) {
      dynamicObserver.disconnect();
      dynamicObserver = null;
    }

    clearTimeout(dynamicTranslateTimer);
    dynamicTranslateTimer = null;
  }

  async function handleToggleTranslate() {
    if (isProcessing) return;

    if (isTranslated) {
      restoreOriginalText();
      return;
    }

    await translatePage();
    startDynamicObserver();
  }

  function ensureButton() {
    if (!document.body) return;

    const existed = document.getElementById(BUTTON_ID);
    if (existed) {
      updateButtonLabel();
      return;
    }

    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.textContent = TRANSLATE_LABEL;

    btn.style.position = 'fixed';
    btn.style.right = '20px';
    btn.style.bottom = '20px';
    btn.style.zIndex = '99999';
    btn.style.padding = '8px 12px';
    btn.style.border = '1px solid var(--borderColor-default, #d0d7de)';
    btn.style.borderRadius = '8px';
    btn.style.background = 'var(--bgColor-default, #fff)';
    btn.style.color = 'var(--fgColor-default, #24292f)';
    btn.style.fontSize = '12px';
    btn.style.fontWeight = '600';
    btn.style.cursor = 'pointer';
    btn.style.boxShadow = '0 1px 4px rgba(0, 0, 0, 0.12)';

    btn.addEventListener('click', handleToggleTranslate);
    document.body.appendChild(btn);
    updateButtonLabel();
  }

  function resetStateForNewPage() {
    translatedNodes.clear();
    pendingRoots.clear();
    isTranslated = false;
    isProcessing = false;
    stopDynamicObserver();
    updateButtonLabel();
  }

  function getRouteKey() {
    return `${location.pathname}${location.search}`;
  }

  function handleRouteMaybeChanged() {
    const current = getRouteKey();
    if (current === lastRouteKey) return;

    lastRouteKey = current;
    resetStateForNewPage();

    setTimeout(() => {
      ensureButton();
    }, 180);
  }

  function installHistoryHooks() {
    if (historyHooked) return;
    historyHooked = true;

    const rawPushState = history.pushState;
    const rawReplaceState = history.replaceState;

    history.pushState = function pushStatePatched(...args) {
      const result = rawPushState.apply(this, args);
      setTimeout(handleRouteMaybeChanged, 0);
      return result;
    };

    history.replaceState = function replaceStatePatched(...args) {
      const result = rawReplaceState.apply(this, args);
      setTimeout(handleRouteMaybeChanged, 0);
      return result;
    };
  }

  function init() {
    loadPersistedCache();
    lastRouteKey = getRouteKey();
    ensureButton();
    installHistoryHooks();

    window.addEventListener('turbo:render', handleRouteMaybeChanged, true);
    window.addEventListener('pjax:end', handleRouteMaybeChanged, true);
    window.addEventListener('popstate', handleRouteMaybeChanged, true);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        handleRouteMaybeChanged();
        ensureButton();
      }
    });
  }

  init();
})();

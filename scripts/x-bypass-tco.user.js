// ==UserScript==
// @name         Bypass t.co on Copy
// @namespace    net.appgrove.userscripts
// @version      1.0.0
// @description  Bypass t.co shortener when copying links from X/Twitter.
// @author       appgrove
// @license      Apache-2.0
// @homepageURL  https://github.com/App-Grove/AppGrove-s-UserScripts
// @supportURL   https://github.com/AppGrove/AppGrove-s-UserScripts/issues
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://mobile.x.com/*
// @match        https://mobile.twitter.com/*
// @run-at       document-start
// @inject-into  auto
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      t.co
// @connect      *
// @updateURL    https://raw.githubusercontent.com/App-Grove/AppGrove-s-UserScripts/main/scripts/x-bypass-tco.user.js
// ==/UserScript==

(() => {
  'use strict';

  const DEBUG = false;
  const log = (...args) =>
    DEBUG && console.debug('[tco-tooltip]', ...args);

  const cache = new Map();
  const pending = new Map();
  let hoveredLink = null;
  let scheduled = false;
  let copySequence = 0;

  function isTco(raw) {
    try {
      const url = new URL(raw);
      return /^https?:$/.test(url.protocol) &&
        url.hostname.toLowerCase() === 't.co' &&
        /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
    } catch {
      return false;
    }
  }

  function fullUrl(raw) {
    const text = String(raw || '').trim();
    if (!/^https?:\/\/\S+$/i.test(text) ||
        /\u2026/.test(text)) return null;

    try {
      const url = new URL(text);
      if (!/^https?:$/.test(url.protocol) ||
          url.hostname.toLowerCase() === 't.co') {
        return null;
      }
      return url.href;
    } catch {
      return null;
    }
  }

  // 表示URLとツールチップURLが一致するか確認
  function labelMatchesLink(link, expanded) {
    const visiblePrefix = (link.textContent || '')
      .replace(/[\u200b\u200c\u200d]/g, '')
      .split('\u2026')[0]
      .replace(/\s+/g, '');

    if (visiblePrefix.length < 8) return false;

    const withoutScheme = s =>
      s.replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '');

    return withoutScheme(expanded)
      .startsWith(withoutScheme(visiblePrefix));
  }

  function apply(link, expanded) {
    if (!link || !link.isConnected) return false;

    const original = link.href;
    if (!isTco(original)) return original === expanded;

    cache.set(original, expanded);
    link.setAttribute('href', expanded);

    log('hrefを書き換え:', original, '=>', expanded);
    return true;
  }

  // Xが表示するHoverLabelから完全なURLを取得
  function tryTooltip(link) {
    if (!link || !link.isConnected ||
        !isTco(link.href)) return false;

    if (cache.has(link.href)) {
      return apply(link, cache.get(link.href));
    }

    const labels = document.querySelectorAll(
      '[role="tooltip"] [data-testid="HoverLabel"]'
    );

    for (const label of labels) {
      if (!label.getClientRects().length) continue;

      const expanded = fullUrl(label.textContent);

      if (expanded && labelMatchesLink(link, expanded)) {
        log('ツールチップからURLを取得:', expanded);
        return apply(link, expanded);
      }
    }

    return false;
  }

  function updateFromTooltip() {
    scheduled = false;

    if (hoveredLink &&
        hoveredLink.isConnected &&
        hoveredLink.matches(':hover')) {
      tryTooltip(hoveredLink);
    }
  }

  function scheduleUpdate() {
    if (scheduled || !hoveredLink) return;

    scheduled = true;
    queueMicrotask(updateFromTooltip);
  }

  // カーソルが乗っているリンクを記録
  document.addEventListener('pointerover', event => {
    const link = event.target?.closest?.('a[href]');
    if (!link) return;

    if (isTco(link.href)) {
      hoveredLink = link;
      log('ホバー:', link.href);
      scheduleUpdate();
    }
  }, true);

  // Xはホバー後にツールチップを動的に生成する
  function startObserver() {
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type !== 'attributes') continue;

        const link = record.target;

        if (link instanceof HTMLAnchorElement &&
            isTco(link.href) &&
            cache.has(link.href)) {
          apply(link, cache.get(link.href));
        }
      }

      scheduleUpdate();
    });

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['href'],
    });

    log('監視開始:', location.href);
  }

  if (document.documentElement) {
    startObserver();
  } else {
    document.addEventListener(
      'DOMContentLoaded',
      startObserver,
      { once: true }
    );
  }

  // Firefoxの右クリックメニュー表示前に最終確認
  for (const eventType of ['pointerdown', 'contextmenu']) {
    document.addEventListener(eventType, event => {
      if (eventType === 'pointerdown' &&
          event.button !== 2) return;

      const link = event.target?.closest?.('a[href]');
      if (!link) return;

      tryTooltip(link);

      if (eventType === 'contextmenu') {
        log('右クリック時のhref:', link.href);

        if (isTco(link.href)) {
          log('未展開: ツールチップ表示後に右クリックしてください');
        }
      }
    }, true);
  }

  // Ctrl+C向け: 未取得のURLをリダイレクトで解決
  function resolveByRedirect(short) {
    if (cache.has(short)) {
      return Promise.resolve(cache.get(short));
    }

    if (pending.has(short)) return pending.get(short);

    const promise = new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'HEAD',
        url: short,
        timeout: 8000,
        onload: response =>
          resolve(fullUrl(response.finalUrl)),
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    }).then(expanded => {
      pending.delete(short);

      if (expanded) cache.set(short, expanded);
      return expanded;
    });

    pending.set(short, promise);
    return promise;
  }

  function selectionText() {
    const focused = document.activeElement;

    if (focused && (
      focused.tagName === 'TEXTAREA' ||
      (focused.tagName === 'INPUT' &&
       typeof focused.selectionStart === 'number')
    )) {
      if (focused.selectionStart !== focused.selectionEnd) {
        return focused.value.slice(
          focused.selectionStart,
          focused.selectionEnd
        );
      }
    }

    return window.getSelection()?.toString() || '';
  }

  // Ctrl+Cにも対応
  document.addEventListener('copy', event => {
    const selected = selectionText();

    const pattern =
      /https?:\/\/t\.co\/[A-Za-z0-9_-]+/gi;

    const shorts = [...new Set(
      selected.match(pattern) || []
    )];

    if (!shorts.length) return;

    const seq = ++copySequence;

    const replaceKnown = () =>
      selected.replace(
        /https?:\/\/t\.co\/[A-Za-z0-9_-]+/gi,
        short => cache.get(short) || short
      );

    if (shorts.every(short => cache.has(short)) &&
        event.clipboardData) {
      event.clipboardData.setData(
        'text/plain',
        replaceKnown()
      );
      event.preventDefault();
      log('選択コピーを書き換えました');
    } else {
      void Promise.all(
        shorts.map(resolveByRedirect)
      ).then(() => {
        if (seq !== copySequence ||
            !document.hasFocus() ||
            document.visibilityState !== 'visible') {
          return;
        }

        const expanded = replaceKnown();

        if (expanded !== selected) {
          GM_setClipboard(expanded, 'text');
          log('選択コピーを後から更新しました');
        }
      });
    }
  }, true);
})();

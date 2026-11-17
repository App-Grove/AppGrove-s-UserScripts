// ==UserScript==
// @name         Old Article URL Redirector for note
// @namespace    net.appgrove.userscripts
// @version      1.0.0
// @description  redirect note articles from changed usernames to new URLs.
// @author       appgrove
// @license      Apache-2.0
// @homepageURL  https://github.com/App-Grove/AppGrove-s-UserScripts
// @supportURL   https://github.com/App-Grove/AppGrove-s-UserScripts/issues
// @match        https://note.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/App-Grove/AppGrove-s-UserScripts/main/scripts/note-old-url-recovery.user.js
// ==/UserScript==

(() => {
  'use strict';

  const ARTICLE_PATH = /^\/([\w-]+)\/n\/(n[0-9a-f]{12})\/?$/;
  const ERROR_HEADING = 'お探しのページが見つかりません。';
  const RETRY_DELAY = 5 * 60 * 1000;
  let observedHref = location.href;
  let timer = null;
  let navigating = false;

  function findCurrentUrl(articleKey, current) {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try {
        data = JSON.parse(script.textContent);
      } catch {
        continue;
      }

      const entries = Array.isArray(data) ? [...data] : [data];
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry || typeof entry !== 'object') continue;
        if (Array.isArray(entry['@graph'])) entries.push(...entry['@graph']);
        const types = [].concat(entry['@type'] || []);
        if (!types.includes('BlogPosting')) continue;

        const entity = entry.mainEntityOfPage;
        const value = typeof entity === 'string' ? entity : entity?.['@id'];
        if (typeof value !== 'string') continue;

        try {
          const candidate = new URL(value);
          const match = candidate.pathname.match(ARTICLE_PATH);
          if (
            candidate.origin === 'https://note.com' &&
            !candidate.username && !candidate.password &&
            match?.[2] === articleKey &&
            candidate.pathname.replace(/\/$/, '') !== current.pathname.replace(/\/$/, '')
          ) {
            return candidate;
          }
        } catch {
          // 不正なURLは無視して、残りのJSON-LDを調べる。
        }
      }
    }
    return null;
  }

  function claimAttempt(articleKey) {
    // note側が元の404へ戻す場合にも、ページ再読み込みをまたいでループを防ぐ。
    const key = `appgrove:note-url-recovery:${articleKey}`;
    try {
      const now = Date.now();
      const previous = Number(sessionStorage.getItem(key));
      if (previous && now - previous < RETRY_DELAY) return false;
      sessionStorage.setItem(key, String(now));
      return true;
    } catch {
      console.warn('[note URL Recovery] sessionStorageを利用できないため、自動転送を中止しました。');
      return false;
    }
  }

  function recover() {
    timer = null;
    if (navigating) return;
    if (location.href !== observedHref) {
      scheduleCheck();
      return;
    }

    const current = new URL(location.href);
    const match = current.pathname.match(ARTICLE_PATH);
    if (current.origin !== 'https://note.com' || !match) return;
    const is404 = [...document.querySelectorAll('h1')].some(
      heading => heading.textContent?.trim() === ERROR_HEADING
    );
    if (!is404) return;

    const articleKey = match[2];
    const target = findCurrentUrl(articleKey, current) ||
      new URL(`/notes/${articleKey}`, current.origin);
    target.search = current.search;
    target.hash = current.hash;
    if (!claimAttempt(articleKey)) return;

    navigating = true;
    location.replace(target.href);
  }

  function scheduleCheck() {
    const changed = observedHref !== location.href;
    observedHref = location.href;
    if (changed) {
      clearTimeout(timer);
      timer = null;
    }
    // SPA遷移直後の古いDOMを避け、JSON-LDの遅延挿入も少し待つ。
    if (timer === null) timer = setTimeout(recover, 500);
  }

  // 非記事ページからSPAで記事へ入る場合も対象にするため、@matchはnote全体。
  const observer = new MutationObserver(scheduleCheck);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
  // ページのHistory APIを書き換えず、DOM更新を伴わないURL変更も検出する。
  setInterval(() => {
    if (location.href !== observedHref) scheduleCheck();
  }, 1000);
  scheduleCheck();
})();

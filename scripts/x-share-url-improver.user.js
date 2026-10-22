// ==UserScript==
// @name         Twitter/X Share URL Improver
// @namespace    net.appgrove.userscripts
// @version      1.0.0
// @description  Copy with fixupx.com and remove parameters
// @author       appgrove
// @license      Apache-2.0
// @homepageURL  https://github.com/App-Grove/AppGrove-s-UserScripts
// @supportURL   https://github.com/App-Grove/AppGrove-s-UserScripts/issues
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://mobile.x.com/*
// @match        https://mobile.twitter.com/*
// @run-at       document-idle
// @grant        GM_setClipboard
// @updateURL   https://raw.githubusercontent.com/App-Grove/AppGrove-s-UserScripts/main/scripts/x-share-url-improver.user.js
// ==/UserScript==

(() => {
  'use strict';

  const FIXUP_LABEL = 'fixupx.comでリンクをコピー';

  const CHAT_LABELS = new Set([
    'チャット経由で送信',
    'Send via chat',
    'Share via chat',
    'Send via Direct Message',
    'Share via Direct Message',
    'Send via DM',
    'Share via DM'
  ]);

  const COPY_LABELS = new Set([
    'リンクをコピー',
    'ポストのリンクをコピー',
    'Copy link',
    'Copy link to post',
    'Copy link to Tweet'
  ]);

  // コピーアイコンのパス
  const COPY_ICON_PATH =
    'M16 1H4C2.9 1 2 1.9 2 3v14h2V3h12V1zm3 4H8C6.9 5 6 5.9 6 7v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  let activePostUrl = null;
  let activeShareButton = null;
  let toastTimer = null;

  function normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function isChatLabel(text) {
    const label = normalizeText(text);

    if (CHAT_LABELS.has(label)) {
      return true;
    }

    return /^(send|share)\b.*\b(chat|direct message|dm)\b/i.test(label);
  }

  function isCopyLabel(text) {
    const label = normalizeText(text);

    if (COPY_LABELS.has(label)) {
      return true;
    }

    return /^copy link(?: to (?:post|tweet))?$/i.test(label);
  }

  /**
   * 投稿URLをユーザー名/status/投稿IDの形に正規化する。
   * クエリパラメータ、ハッシュ、photo等の後続パスは含めない。
   */
  function buildPostUrl(href, mode = 'normal') {
    try {
      const url = new URL(href, location.href);

      if (!/^(?:www\.)?(?:x\.com|twitter\.com|fixupx\.com)$/i.test(url.hostname)) {
        return null;
      }

      const match = url.pathname.match(
        /^\/([^/]+)\/status\/(\d+)(?:\/|$)/
      );

      if (!match) {
        return null;
      }

      const username = match[1];
      const postId = match[2];

      if (mode === 'fixupx') {
        return `https://fixupx.com/${username}/status/${postId}`;
      }

      const hostname = url.hostname.replace(/^www\./i, '');

      return `https://${hostname}/${username}/status/${postId}`;
    } catch {
      return null;
    }
  }

  /**
   * 共有ボタンがある投稿から、元投稿のURLを取得する。
   * タイムスタンプ内のリンクを優先し、引用投稿のURLを拾いにくくする。
   */
  function getPostUrlFromTweet(tweet) {
    if (!tweet) {
      return null;
    }

    const anchors = [...tweet.querySelectorAll('a[href*="/status/"]')];

    anchors.sort((a, b) => {
      const aHasTime = a.querySelector('time') ? 1 : 0;
      const bHasTime = b.querySelector('time') ? 1 : 0;
      return bHasTime - aHasTime;
    });

    for (const anchor of anchors) {
      const url = buildPostUrl(anchor.href, 'normal');

      if (url) {
        return url;
      }
    }

    return null;
  }

  function setCopyIcon(item) {
    const svg = item.querySelector('svg');

    if (!svg) {
      return;
    }

    const existingPath = svg.querySelector('path');

    if (
      svg.children.length === 1 &&
      existingPath?.getAttribute('d') === COPY_ICON_PATH
    ) {
      return;
    }

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', COPY_ICON_PATH);

    svg.replaceChildren(path);
  }

  function setItemLabel(item, label, newLabel) {
    if (normalizeText(label.textContent) !== newLabel) {
      label.textContent = newLabel;
    }

    if (item.getAttribute('aria-label') !== newLabel) {
      item.setAttribute('aria-label', newLabel);
    }
  }

  function processMenuItem(item) {
    const spans = [...item.querySelectorAll('span')];

    // 一度変更した項目は、X側がDOMを再描画した場合も修復する。
    if (item.dataset.fixupxKind === 'fixupx') {
      const label = spans.find(span => {
        const text = normalizeText(span.textContent);
        return isChatLabel(text) || text === FIXUP_LABEL;
      });

      if (label) {
        setItemLabel(item, label, FIXUP_LABEL);
      }

      setCopyIcon(item);
      return;
    }

    if (item.dataset.fixupxKind === 'normal') {
      return;
    }

    // 「チャット経由で送信」をfixupx.com用のコピー項目に置き換える。
    const chatLabel = spans.find(span =>
      isChatLabel(span.textContent)
    );

    if (chatLabel) {
      item.dataset.fixupxKind = 'fixupx';
      setItemLabel(item, chatLabel, FIXUP_LABEL);
      setCopyIcon(item);
      return;
    }

    // 通常の「リンクをコピー」も、独自処理でパラメータを除去する。
    const copyLabel = spans.find(span =>
      isCopyLabel(span.textContent)
    );

    if (copyLabel) {
      item.dataset.fixupxKind = 'normal';
    }
  }

  function scanMenus() {
    document.querySelectorAll(
      '[data-testid="Dropdown"] [role="menuitem"], ' +
      '[role="menu"] [role="menuitem"]'
    ).forEach(processMenuItem);
  }

  function showToast(message) {
    let toast = document.getElementById('fixupx-userscript-toast');

    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'fixupx-userscript-toast';

      toast.style.cssText = [
        'position:fixed',
        'left:50%',
        'bottom:24px',
        'transform:translateX(-50%)',
        'z-index:2147483647',
        'padding:10px 16px',
        'border-radius:8px',
        'background:#202124',
        'color:#fff',
        'font:14px/1.4 sans-serif',
        'box-shadow:0 2px 10px #0005',
        'pointer-events:none'
      ].join(';');

      document.documentElement.appendChild(toast);
    }

    toast.textContent = message;
    toast.style.display = 'block';

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
      toast?.remove();
    }, 1800);
  }

  async function writeClipboard(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text, 'text');
      return;
    }

    await navigator.clipboard.writeText(text);
  }

  function closeMenu(item) {
    // メニュー項目からEscapeを送信し、通常のメニュー終了処理を促す。
    item.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true
    }));

    // 閉じなかった場合は共有ボタンを再クリックする。
    setTimeout(() => {
      const menuIsVisible = [
        ...document.querySelectorAll('[data-testid="Dropdown"], [role="menu"]')
      ].some(menu => menu.getClientRects().length > 0);

      if (menuIsVisible && activeShareButton?.isConnected) {
        activeShareButton.click();
      }
    }, 50);
  }

  // 共有ボタンが押された時点で、対象の投稿URLを保存する。
  document.addEventListener('click', event => {
    const target = event.target;

    if (!(target instanceof Element)) {
      return;
    }

    const button = target.closest(
      'button[aria-haspopup="menu"][aria-label]'
    );

    if (!button || !/共有|share/i.test(button.getAttribute('aria-label') || '')) {
      return;
    }

    const tweet = button.closest('[data-testid="tweet"], article');

    activePostUrl =
      getPostUrlFromTweet(tweet) ||
      buildPostUrl(location.href, 'normal');

    activeShareButton = button;
  }, true);

  // 通常コピーとfixupx.comコピーの両方を独自処理する。
  document.addEventListener('click', async event => {
    const target = event.target;

    if (!(target instanceof Element)) {
      return;
    }

    const item = target.closest(
      '[role="menuitem"][data-fixupx-kind]'
    );

    if (!item) {
      return;
    }

    // X標準のコピー処理を止め、クリーンなURLをコピーする。
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const sourceUrl =
      activePostUrl ||
      buildPostUrl(location.href, 'normal');

    if (!sourceUrl) {
      showToast('投稿URLを取得できませんでした');
      return;
    }

    const mode = item.dataset.fixupxKind;
    const copyUrl = buildPostUrl(
      sourceUrl,
      mode === 'fixupx' ? 'fixupx' : 'normal'
    );

    if (!copyUrl) {
      showToast('投稿URLを取得できませんでした');
      return;
    }

    try {
      await writeClipboard(copyUrl);

      showToast('リンクをコピーしました');
      closeMenu(item);
    } catch (error) {
      console.error('[fixupx-share]', error);
      showToast('クリップボードへのコピーに失敗しました');
    }
  }, true);

  // Xは動的にメニューを生成するため、DOMの追加・更新を監視する。
  const observer = new MutationObserver(scanMenus);

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  scanMenus();
})();

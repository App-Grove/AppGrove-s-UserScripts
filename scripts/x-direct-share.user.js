// ==UserScript==
// @name         Twitter/X Direct Share URL
// @namespace    net.appgrove.userscripts
// @version      1.0.0
// @description  Direct
// @author       appgrove
// @license      Apache-2.0
// @homepageURL  https://github.com/App-Grove/AppGrove-s-UserScripts
// @supportURL   https://github.com/App-Grove/AppGrove-s-UserScripts/issues
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://mobile.x.com/*
// @match        https://mobile.twitter.com/*
// @run-at       document-start
// @grant        GM_setClipboard
// @noframes
// @updateURL   https://raw.githubusercontent.com/App-Grove/AppGrove-s-UserScripts/main/scripts/x-direct-share.user.js
// ==/UserScript==

(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * 設定
   * ------------------------------------------------------------------ */
  const TWEET_SELECTOR = 'article[data-testid="tweet"], article[role="article"]';

  // 日本語・英語に限らず、主要言語の「共有」系ラベルを拾う。
  // ラベルが変わっても、下の共有アイコン判定でフォールバックできる。
  const SHARE_LABEL_RE =
    /(?:共有|シェア|share|teilen|partager|compartir|condividi|compartilhar|공유|分享)/i;

  // X の共有アイコン（上向き矢印＋トレイ）の path。
  // ラベルが未翻訳・未知の言語でも共有ボタンだと判定するための保険。
  const SHARE_ICON_PATH_RE = /^M12 2\.59l5\.7 5\.7-1\.41 1\.42L13 6\.41V16h-2V6\.41/;

  const TOAST_ID = "x-share-copy-toast";
  const TOAST_VISIBLE_MS = 1800;

  let toastEl = null;
  let toastTimer = 0;

  /* ------------------------------------------------------------------ *
   * ユーティリティ
   * ------------------------------------------------------------------ */
  /**
   * ポストの href を正規化する。
   * 例: /user/status/123/photo/1?foo=bar -> https://x.com/user/status/123
   */
  function canonicalStatusUrl(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      const match = url.pathname.match(/^\/([^/?#]+)\/status\/(\d+)(?:\/|$)/);
      if (!match) return null;
      return `https://x.com/${match[1]}/status/${match[2]}`;
    } catch {
      return null;
    }
  }

  /** 記事内から、そのポスト自身の URL を取得する */
  function getTweetUrl(article) {
    // ヘッダーの日時リンクが最も確実。引用ポスト内の日時より前に
    // 外側のポストの日時が来るため、最初の time を持つリンクを使う。
    const timeLink = article.querySelector('a[href*="/status/"] time')?.closest("a");
    const timeUrl = canonicalStatusUrl(timeLink?.getAttribute("href"));
    if (timeUrl) return timeUrl;

    // 日時リンクが見つからない場合のフォールバック。
    // アナリティクス等の派生 URL でも、正規化すれば同じポスト URL になる。
    for (const anchor of article.querySelectorAll('a[href*="/status/"]')) {
      const url = canonicalStatusUrl(anchor.getAttribute("href"));
      if (url) return url;
    }

    // 稀に記事内にリンクがない場合は、現在のステータスページから補完する。
    return canonicalStatusUrl(location.href);
  }

  /** クリック対象が「ポストの共有ボタン」なら、そのボタンを返す */
  function findShareButton(target) {
    if (!target || typeof target.closest !== "function") return null;

    // aria-haspopup の有無に依存せず、まずボタン自体を特定する。
    const button = target.closest('button, [role="button"]');
    if (!button || !button.closest(TWEET_SELECTOR)) return null;

    const label = (button.getAttribute("aria-label") || "").trim();
    if (SHARE_LABEL_RE.test(label)) return button;

    // ラベルが未知の言語でも、共有アイコンなら対象にする。
    const iconPath = button.querySelector("svg path")?.getAttribute("d") || "";
    if (SHARE_ICON_PATH_RE.test(iconPath)) return button;

    return null;
  }

  /** クリップボードへコピーする。GM_setClipboard を優先し、失敗時は標準APIへ。 */
  async function copyText(text) {
    try {
      if (typeof GM_setClipboard === "function") {
        GM_setClipboard(text, "text");
        return true;
      }
    } catch {
      // 標準API / execCommand へフォールバック
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // execCommand へフォールバック
    }

    let textarea = null;
    try {
      textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.cssText =
        "position:fixed;top:0;left:-9999px;opacity:0;pointer-events:none;";
      (document.body || document.documentElement).appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      textarea?.remove();
    }
  }

  /** 画面下に短い通知を出す */
  function ensureToast() {
    if (toastEl?.isConnected) return toastEl;

    toastEl = document.getElementById(TOAST_ID);
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = TOAST_ID;
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      toastEl.style.cssText = [
        "position: fixed",
        "left: 50%",
        "bottom: 32px",
        "transform: translate(-50%, 12px)",
        "z-index: 2147483647",
        "margin: 0",
        "padding: 10px 16px",
        "border-radius: 9999px",
        "background: rgba(15, 20, 25, 0.94)",
        "color: #fff",
        'font: 600 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif',
        "letter-spacing: 0.01em",
        "box-shadow: 0 4px 18px rgba(0, 0, 0, 0.28)",
        "opacity: 0",
        "pointer-events: none",
        "transition: opacity 0.18s ease, transform 0.18s ease",
        "white-space: nowrap",
      ].join(";");
      (document.body || document.documentElement).appendChild(toastEl);
    }
    return toastEl;
  }

  function showToast(message, isError = false) {
    const el = ensureToast();
    el.textContent = message;
    el.style.background = isError
      ? "rgba(244, 33, 46, 0.96)"
      : "rgba(15, 20, 25, 0.94)";

    // 連続クリック時もフェードインし直す
    el.style.opacity = "0";
    el.style.transform = "translate(-50%, 12px)";
    void el.offsetWidth;
    el.style.opacity = "1";
    el.style.transform = "translate(-50%, 0)";

    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translate(-50%, 12px)";
    }, TOAST_VISIBLE_MS);
  }

  /* ------------------------------------------------------------------ *
   * クリック処理
   * ------------------------------------------------------------------ */
  async function handleClick(event) {
    if (event.defaultPrevented || event.button !== 0) return;

    const shareButton = findShareButton(event.target);
    if (!shareButton) return;

    const article = shareButton.closest(TWEET_SELECTOR);
    if (!article) return;

    // X（React）のクリックハンドラより先に止め、共有メニューを開かせない。
    // window の capture で止めることで、ページ側の bubble ハンドラへ渡らない。
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();

    const url = getTweetUrl(article);
    if (!url) {
      showToast("ポストのURLを取得できませんでした", true);
      return;
    }

    const copied = await copyText(url);
    if (copied) {
      showToast("ポストのURLをコピーしました");
    } else {
      showToast("コピーできませんでした", true);
    }
  }

  // document-start から登録し、SPA で後から描画されるポストにも対応する。
  window.addEventListener("click", handleClick, true);
})();

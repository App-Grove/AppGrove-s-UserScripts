// ==UserScript==
// @name         TenbinAI Auto Theme
// @namespace    net.appgrove.userscripts
// @version      1.0.0
// @description  Sync GMO Tenbin AI's theme setting with the OS
// @author       appgrove
// @license      Apache-2.0
// @homepageURL  https://github.com/App-Grove/AppGrove-s-UserScripts
// @supportURL   https://github.com/App-Grove/AppGrove-s-UserScripts/issues
// @match        https://sites.google.com/view/*
// @run-at       document-start
// @grant        none
// @noframes
// @updateURL   https://raw.githubusercontent.com/App-Grove/AppGrove-s-UserScripts/main/scripts/tenbinai-auto-theme.user.js
// ==/UserScript==

(function () {
  "use strict";

  // ========================= 設定 =========================
  /** true にすると、本体側の手動トグルで上書きされたら尊重する（端末設定に戻さない） */
  const RESPECT_MANUAL_TOGGLE = false;
  /** true にするとコンソールに動作ログを出す */
  const DEBUG = false;
  // =======================================================

  const STORAGE_KEY = "theme"; // 天秤AI(next-themes) が使う localStorage キー
  const ATTRIBUTE = "data-theme"; // 天秤AI の CSS が参照する属性
  const MEDIA_QUERY = "(prefers-color-scheme: dark)";

  const mql = window.matchMedia(MEDIA_QUERY);

  function debug(...args) {
    if (DEBUG) console.debug("[tenbin-auto-dark-mode]", ...args);
  }

  /** 端末設定から "dark" / "light" を解決する */
  function resolveTheme() {
    return mql.matches ? "dark" : "light";
  }

  /**
   * next-themes は storage イベントで localStorage の変更を検知して
   * 内部 state(setTheme) を更新する。同一ドキュメント内の setItem では
   * storage イベントが発火しないため、手動で発火させて React 側と同期する。
   */
  function emitStorageEvent(theme) {
    var ev;
    try {
      ev = new StorageEvent("storage", {
        key: STORAGE_KEY,
        oldValue: null,
        newValue: theme,
        storageArea: localStorage,
        url: location.href
      });
    } catch (e) {
      ev = new Event("storage");
      var props = { key: STORAGE_KEY, oldValue: null, newValue: theme };
      Object.keys(props).forEach(function (k) {
        try {
          Object.defineProperty(ev, k, { value: props[k] });
        } catch (e2) {
          /* ignore */
        }
      });
    }
    window.dispatchEvent(ev);
  }

  /** 端末設定の色を localStorage と DOM の両方へ反映する */
  function apply(reason) {
    var theme = resolveTheme();
    var changed = false;

    try {
      if (localStorage.getItem(STORAGE_KEY) !== theme) {
        localStorage.setItem(STORAGE_KEY, theme);
        changed = true;
      }
    } catch (e) {
      /* localStorage が無効な環境では DOM だけ更新する */
    }

    var root = document.documentElement;
    if (root) {
      if (root.getAttribute(ATTRIBUTE) !== theme) {
        root.setAttribute(ATTRIBUTE, theme);
      }
      // スクロールバーなどネイティブ UI の色も合わせる
      if (root.style.colorScheme !== theme) {
        root.style.colorScheme = theme;
      }
    }

    // localStorage を書き換えたときだけ React 側へ通知する
    if (changed) emitStorageEvent(theme);

    debug("apply:", theme, "(" + reason + ")");
  }

  // 1) 端末設定の変化に追従（Chrome/Firefox は addEventListener、旧実装は addListener）
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", function () {
      apply("media-change");
    });
  } else if (typeof mql.addListener === "function") {
    mql.addListener(function () {
      apply("media-change");
    });
  }

  // 2) documentElement がまだ無い場合は生成を待ってから適用する
  function onRootReady(callback) {
    if (document.documentElement) {
      callback();
      return;
    }
    var obs = new MutationObserver(function () {
      if (document.documentElement) {
        obs.disconnect();
        callback();
      }
    });
    obs.observe(document, { childList: true });
    document.addEventListener("readystatechange", function onReady() {
      if (document.documentElement) {
        document.removeEventListener("readystatechange", onReady);
        obs.disconnect();
        callback();
      }
    });
  }

  onRootReady(function () {
    apply("startup");

    if (RESPECT_MANUAL_TOGGLE) return;

    // 3) 本体のトグルやハイドレーションで上書きされたら端末設定へ戻す
    var guard = new MutationObserver(function () {
      if (document.documentElement.getAttribute(ATTRIBUTE) !== resolveTheme()) {
        apply("site-override");
      }
    });
    guard.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [ATTRIBUTE]
    });
  });
})();

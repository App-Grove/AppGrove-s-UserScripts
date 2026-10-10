// ==UserScript==
// @name         Show All Posts on Twitter/X Profiles
// @namespace    net.appgrove.userscripts
// @version      1.0.0
// @description  Opens Twitter/X profiles to the "All" posts view by default instead of the "Posts" tab.
// @author       appgrove
// @license      Apache-2.0
// @homepageURL  https://github.com/App-Grove/AppGrove-s-UserScripts
// @supportURL   https://github.com/App-Grove/AppGrove-s-UserScripts/issues
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/App-Grove/AppGrove-s-UserScripts/main/scripts/x-show-all-posts-on-profiles.user.js
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  // プロフィール名と区別するXの予約済みパス
  const RESERVED = new Set([
    "about",
    "account",
    "ads",
    "analytics",
    "articles",
    "bookmarks",
    "communities",
    "compose",
    "explore",
    "hashtag",
    "home",
    "i",
    "intent",
    "jobs",
    "lists",
    "login",
    "logout",
    "messages",
    "notifications",
    "premium",
    "privacy",
    "search",
    "settings",
    "signup",
    "tos",
    "verified"
  ]);

  let currentProfile = null;
  let lastPath = "";

  function getProfile(pathname) {
    const match = pathname.match(/^\/([A-Za-z0-9_]{1,20})\/?$/);
    if (!match || RESERVED.has(match[1].toLowerCase())) return null;
    return match[1];
  }

  function getAllProfile(pathname) {
    const match = pathname.match(/^\/([A-Za-z0-9_]{1,20})\/all\/?$/);
    if (!match || RESERVED.has(match[1].toLowerCase())) return null;
    return match[1];
  }

  function isAllPath(pathname, username) {
    const allUsername = getAllProfile(pathname);
    return !!allUsername && allUsername.toLowerCase() === username.toLowerCase();
  }

  function redirectToAll(username) {
    const target = `/${username}/all${location.search}${location.hash}`;
    try {
      history.replaceState(history.state, "", target);
      // XにURLの変更を認識させる
      window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    } catch {
      // 書き換えに失敗した場合は何もしない
    }
  }

  function handleNavigation() {
    const pathname = location.pathname;
    if (pathname === lastPath) return;

    const previousPath = lastPath;
    lastPath = pathname;

    const allUsername = getAllProfile(pathname);
    if (allUsername) {
      currentProfile = allUsername.toLowerCase();
      return;
    }

    const username = getProfile(pathname);
    if (username) {
      const normalizedUsername = username.toLowerCase();

      // 同じプロフィールで「すべて」から「ポスト」に切り替えた操作は尊重する
      if (
        currentProfile === normalizedUsername &&
        isAllPath(previousPath, normalizedUsername)
      ) {
        return;
      }

      currentProfile = normalizedUsername;
      redirectToAll(username);
      return;
    }

    currentProfile = null;
  }

  // XのSPA内のページ遷移を監視
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      setTimeout(handleNavigation, 0);
      return result;
    };
  }

  window.addEventListener("popstate", () => setTimeout(handleNavigation, 0));

  // XがHistory APIを後から差し替えた場合などへの保険
  setInterval(handleNavigation, 300);

  // 初回表示
  handleNavigation();
})();

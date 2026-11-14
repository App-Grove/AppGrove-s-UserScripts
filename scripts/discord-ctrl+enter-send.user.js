// ==UserScript==
// @name         Discord Ctrl+Enter to Send
// @namespace    net.appgrove.userscripts
// @version      1.0.0
// @description  Use Enter for a new line and Ctrl+Enter to send in Discord chat.
// @author       appgrove
// @license      Apache-2.0
// @homepageURL  https://github.com/App-Grove/AppGrove-s-UserScripts
// @supportURL   https://github.com/App-Grove/AppGrove-s-UserScripts/issues
// @match        https://discord.com/*
// @match        https://ptb.discord.com/*
// @match        https://canary.discord.com/*
// @run-at       document-start
// @inject-into  content
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/App-Grove/AppGrove-s-UserScripts/main/scripts/discord-ctrl%2Benter-send.user.js
// ==/UserScript==

(() => {
  'use strict';

  const composerSelector = '[class*="channelTextArea_"] [data-slate-editor="true"][contenteditable="true"][role="textbox"][aria-multiline="true"]';

  // Add the hint without changing Discord's React-managed placeholder text.
  const style = document.createElement('style');
  style.textContent = '[class*="channelTextArea_"] [data-slate-placeholder="true"]::after { content: " (Ctrl+Enter)"; }';
  function addStyle() {
    const parent = document.head || document.documentElement;
    if (!parent) return false;
    parent.appendChild(style);
    return true;
  }
  if (!addStyle()) {
    const observer = new MutationObserver(() => {
      if (addStyle()) observer.disconnect();
    });
    observer.observe(document, {childList: true, subtree: true});
  }

  function dispatchEnter(editor, original, shiftKey) {
    return editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      location: original.location,
      repeat: original.repeat,
      shiftKey,
      bubbles: true,
      cancelable: true,
      composed: true,
    }));
  }

  window.addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.defaultPrevented || event.key !== 'Enter' ||
        event.isComposing || event.keyCode === 229 || !(event.target instanceof Element)) {
      return;
    }

    const editor = event.target.closest(composerSelector);
    if (!editor) {
      return;
    }

    const send = event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
    const newline = !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
    if (!send && !newline) {
      return;
    }

    event.stopImmediatePropagation();
    if (newline) {
      // Discord handles Shift+Enter as a newline. Fall back to the browser's
      // normal editing action if Discord does not handle the synthetic event.
      if (!dispatchEnter(editor, event, true)) {
        event.preventDefault();
      }
      return;
    }

    event.preventDefault();
    if (!event.repeat) {
      dispatchEnter(editor, event, false);
    }
  }, true);
})();

// ==UserScript==
// @name         Fluxer Ctrl+Enter to Send
// @namespace    net.appgrove.userscripts
// @version      1.1.0
// @description  Use Enter for a new line and Ctrl+Enter to send, with a shortcut hint in Fluxer chat.
// @author       appgrove
// @license      Apache-2.0
// @homepageURL  https://github.com/App-Grove/AppGrove-s-UserScripts
// @supportURL   https://github.com/App-Grove/AppGrove-s-UserScripts/issues
// @match        https://fluxer.com/*
// @match        https://web.fluxer.app/*
// @match        https://web.canary.fluxer.app/*
// @run-at       document-start
// @inject-into  content
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/App-Grove/AppGrove-s-UserScripts/main/scripts/fluxer-ctrl%2Benter-send.user.js
// ==/UserScript==

(() => {
  'use strict';

  const editorSelector = 'textarea, [contenteditable="true"], [contenteditable="plaintext-only"]';
  const excludedSelector = [
    '[role="search"]',
    '[role="searchbox"]',
    '[role="combobox"]',
    '[data-lexical-editor][aria-multiline="false"]',
    '[class*="SearchBar" i]',
    '[class*="QuickSwitcher" i]',
    '[role="dialog"]',
  ].join(', ');

  function findComposer(target) {
    if (!(target instanceof Element)) {
      return null;
    }

    // The app changes routes without reloading. Check the current route
    // on each keypress instead of limiting the userscript to /app.
    const inChat = /(?:^|\/)channels(?:\/|$)/.test(location.pathname) ||
      /(?:^|\/)channels(?:\/|$)/.test(location.hash.slice(1));
    const editor = target.closest(editorSelector);
    if (!editor || editor.closest(excludedSelector) || editor.matches('[readonly], [disabled]')) {
      return null;
    }

    const composer = editor.closest(
      '[class*="ChannelTextarea" i], [class*="MessageComposer" i], [class*="ComposerEditor" i]',
    );
    return composer || inChat && editor.matches('textarea, [data-lexical-editor="true"], [aria-multiline="true"]')
      ? editor
      : null;
  }

  const placeholderSuffix = ' (Ctrl+Enter)';

  function updatePlaceholders() {
    const hosts = document.querySelectorAll('flx-channel-textarea-composer');
    for (const host of hosts) {
      const editor = host.querySelector('[data-channel-textarea="true"]');
      if (!findComposer(editor)) {
        continue;
      }

      const label = editor.getAttribute('aria-placeholder');
      if (label && !label.endsWith(placeholderSuffix)) {
        editor.setAttribute('aria-placeholder', label + placeholderSuffix);
      }

      const placeholder = host.querySelector('flx-lexical-composer-input-placeholder');
      const text = placeholder?.textContent;
      if (text && !text.endsWith(placeholderSuffix)) {
        placeholder.textContent = text + placeholderSuffix;
      }
    }
  }

  // Observe from document-start, including channel switches and placeholder
  // replacements when the composer becomes empty. Only write when needed so
  // our own mutations do not cause an observer loop.
  const placeholderObserver = new MutationObserver(updatePlaceholders);
  placeholderObserver.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-placeholder'],
  });
  updatePlaceholders();

  const isMac = /Mac/i.test(navigator.platform);

  function dispatchEnter(editor, original, modifiers) {
    return editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: original.code,
      location: original.location,
      repeat: original.repeat,
      bubbles: true,
      cancelable: true,
      composed: true,
      ...modifiers,
    }));
  }

  window.addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.defaultPrevented || event.key !== 'Enter' ||
        event.isComposing || event.keyCode === 229) {
      return;
    }

    const editor = findComposer(event.target);
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
      // Lexical handles Shift+Enter. If it leaves the event unhandled,
      // let the original key perform the browser's normal editing action.
      if (!dispatchEnter(editor, event, {shiftKey: true})) {
        event.preventDefault();
      }
      return;
    }

    event.preventDefault();
    if (!event.repeat) {
      const anchor = window.getSelection()?.anchorNode;
      const caret = anchor instanceof Element ? anchor : anchor?.parentElement;
      const codeBlock = caret?.closest('pre, [data-language], [data-highlight-language]');
      if (codeBlock && editor.contains(codeBlock)) {
        // Keep the code-block shortcut in the editor. Fluxer also uses
        // this combination as a global shortcut for answering calls.
        dispatchEnter(editor, event, {ctrlKey: !isMac, metaKey: isMac, bubbles: false});
      } else {
        dispatchEnter(editor, event, {});
      }
    }
  }, true);
})();

// ==UserScript==
// @name         Custom Instruction Injector for DeepSeek
// @namespace    net.appgrove.userscripts
// @version      1.1.0
// @description  Inject custom instructions into DeepSeek chat
// @author       appgrove
// @license      Apache-2.0
// @homepageURL  https://github.com/App-Grove/AppGrove-s-UserScripts
// @supportURL   https://github.com/App-Grove/AppGrove-s-UserScripts/issues
// @match        https://chat.deepseek.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// @updateURL   https://raw.githubusercontent.com/App-Grove/AppGrove-s-UserScripts/main/scripts/deepseek-custom-instruction.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================
   * 設定の永続化
   * ========================================================= */
  const STORAGE_KEY = 'deepseek-sysprompt.v1';
  const DEFAULTS = {
    enabled: true,
    prompt: 'ユーザーはDeepSeekにカスタム指示を与えられるUserScriptをインストールしましたがまだ設定していません。通常のアシスタントとして振る舞いつつ、チャット入力欄横の"⚙"をクリックして設定するよう案内してください。',
  };

  // カスタム指示を囲むタグ
  const INSTRUCTION_OPEN = '<instruction>';
  const INSTRUCTION_CLOSE = '</instruction>';

  // プロンプトを <instruction> ... </instruction> で囲んだブロックを返す
  function buildInstructionBlock(prompt) {
    const body = String(prompt || '').trim();
    if (!body) return '';
    // すでにタグで囲まれている場合は二重に囲まない
    if (body.startsWith(INSTRUCTION_OPEN) && body.endsWith(INSTRUCTION_CLOSE)) {
      return body;
    }
    return INSTRUCTION_OPEN + '\n' + body + '\n' + INSTRUCTION_CLOSE;
  }

  function loadSettings() {
    let raw = null;
    try {
      if (typeof GM_getValue === 'function') raw = GM_getValue(STORAGE_KEY, null);
    } catch (e) { /* ignore */ }
    if (!raw) {
      try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    }
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch (e) { raw = null; }
    }
    return Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
  }

  const settings = loadSettings();

  function persistSettings() {
    const data = { enabled: !!settings.enabled, prompt: String(settings.prompt || '') };
    try {
      if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY, data);
    } catch (e) { /* ignore */ }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* ignore */ }
  }

  /* =========================================================
   * DOM ヘルパー
   * ========================================================= */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function getComposer() {
    // 任意で付けてもらえる安定フック（優先）
    const explicit = document.querySelector('[data-dssp-composer]');
    if (explicit && isVisible(explicit)) return explicit;

    const preferred = document.querySelector('textarea._27c9245');
    if (preferred && isVisible(preferred)) return preferred;

    const withPlaceholder = document.querySelector('textarea[placeholder]');
    if (withPlaceholder && isVisible(withPlaceholder)) return withPlaceholder;

    for (const el of document.querySelectorAll('textarea')) {
      if (isVisible(el) && !el.closest('[data-dssp-ui]')) return el;
    }
    return null;
  }

  function getSendButton(composer) {
    const explicit = document.querySelector('[data-dssp-send]');
    if (explicit && isVisible(explicit)) return explicit;

    const direct = document.querySelectorAll(
      '[role="button"].ds-button--primary.ds-button--circle'
    );
    for (let i = direct.length - 1; i >= 0; i--) {
      if (isVisible(direct[i])) return direct[i];
    }

    // 入力欄の近傍を探すフォールバック
    let node = composer ? composer.parentElement : null;
    for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
      const btns = node.querySelectorAll('[role="button"].ds-button--circle');
      for (let i = btns.length - 1; i >= 0; i--) {
        if (isVisible(btns[i])) return btns[i];
      }
    }

    const primaries = document.querySelectorAll('[role="button"].ds-button--primary');
    for (let i = primaries.length - 1; i >= 0; i--) {
      if (isVisible(primaries[i])) return primaries[i];
    }
    return null;
  }

  const nativeTextAreaSetter = (() => {
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      return desc && typeof desc.set === 'function' ? desc.set : null;
    } catch (e) {
      return null;
    }
  })();

  function setTextareaValue(el, value) {
    // React の value tracker を迂回して onChange を発火させる
    if (nativeTextAreaSetter) nativeTextAreaSetter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /* =========================================================
   * 「そのチャットの最初のメッセージ」判定
   * ========================================================= */
  let lastPathname = location.pathname;
  let firstMessageSent = false;

  function isFirstMessageOfChat() {
    if (location.pathname !== lastPathname) {
      lastPathname = location.pathname;
      firstMessageSent = false;
    }
    if (/\/chat\/s\/[^/]+/.test(location.pathname)) return false;
    return !firstMessageSent;
  }

  /* =========================================================
   * 送信処理
   * ========================================================= */
  let bypass = false;

  function shouldInject(composer) {
    if (!settings.enabled) return false;
    if (!String(settings.prompt || '').trim()) return false;
    if (!composer || !composer.value.trim()) return false;
    return isFirstMessageOfChat();
  }

  function injectAndSend(composer) {
    const raw = composer.value;
    const block = buildInstructionBlock(settings.prompt);
    if (!raw.trim() || !block) return;

    const composed = block + '\n\n' + raw;

    // チラ見せ防止用に現在の色を保存
    const prevColor = composer.style.getPropertyValue('color');
    const prevColorPriority = composer.style.getPropertyPriority('color');
    const prevFill = composer.style.getPropertyValue('-webkit-text-fill-color');
    const prevFillPriority = composer.style.getPropertyPriority('-webkit-text-fill-color');

    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      if (prevColor) composer.style.setProperty('color', prevColor, prevColorPriority);
      else composer.style.removeProperty('color');
      if (prevFill) composer.style.setProperty('-webkit-text-fill-color', prevFill, prevFillPriority);
      else composer.style.removeProperty('-webkit-text-fill-color');
    };

    composer.style.setProperty('color', 'transparent', 'important');
    composer.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');

    setTextareaValue(composer, composed);

    const previousFlag = firstMessageSent;
    firstMessageSent = true;

    const sendButton = getSendButton(composer);
    let clicked = false;

    const clickSend = () => {
      if (clicked || !sendButton) return;
      clicked = true;
      bypass = true;
      try {
        sendButton.click();
      } finally {
        bypass = false;
      }
    };

    if (sendButton && sendButton.classList.contains('ds-button--disabled')) {
      let tries = 0;
      const timer = setInterval(() => {
        tries += 1;
        if (!sendButton.classList.contains('ds-button--disabled')) {
          clearInterval(timer);
          clickSend();
        } else if (tries >= 30) {
          clearInterval(timer);
          setTextareaValue(composer, raw);
          firstMessageSent = previousFlag;
          restore();
        }
      }, 16);
    } else {
      clickSend();
    }

    const startedAt = performance.now();
    const watch = () => {
      // 送信により入力欄がクリアされた（またはユーザーが編集した）
      if (composer.value !== composed) {
        restore();
        return;
      }
      if (performance.now() - startedAt > 1200) {
        // 送信されなかった場合は元の本文に戻す
        setTextareaValue(composer, raw);
        firstMessageSent = previousFlag;
        restore();
        return;
      }
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  }

  /* =========================================================
   * イベントハンドラ
   * ========================================================= */
  function handleKeyDown(e) {
    if (bypass) return;
    if (e.key !== 'Enter') return;
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.isComposing || e.keyCode === 229) return;

    const composer = getComposer();
    if (!composer || e.target !== composer) return;
    if (!shouldInject(composer)) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    injectAndSend(composer);
  }

  function handleClick(e) {
    if (bypass) return;
    if (e.button !== 0) return;

    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    const sendButton = target.closest(
      '[role="button"].ds-button--primary.ds-button--circle, [data-dssp-send]'
    );
    if (!sendButton) return;

    const composer = getComposer();
    if (!shouldInject(composer)) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    injectAndSend(composer);
  }

  /* =========================================================
   * 設定 UI (Shadow DOM)
   * ========================================================= */
  function debounce(fn, wait) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  const ui = (() => {
    let host = null;
    let shadow = null;
    let panel = null;
    let launcher = null;
    let promptInput = null;
    let enabledInput = null;
    let statusEl = null;

    function positionLauncher() {
      if (!launcher) return;
      const composer = getComposer();
      if (!composer) {
        launcher.style.left = 'auto';
        launcher.style.top = 'auto';
        launcher.style.right = '14px';
        launcher.style.bottom = '14px';
        return;
      }
      const rect = composer.getBoundingClientRect();
      const size = 30;
      const gap = 8;
      const spaceRight = window.innerWidth - rect.right;
      if (spaceRight > size + gap + 8) {
        // 入力欄の右横
        launcher.style.left = (rect.right + gap) + 'px';
        launcher.style.top = Math.max(8, rect.top) + 'px';
      } else {
        // 入力欄の右上
        launcher.style.left = Math.max(8, rect.right - size) + 'px';
        launcher.style.top = Math.max(8, rect.top - size - gap) + 'px';
      }
      launcher.style.right = 'auto';
      launcher.style.bottom = 'auto';
    }

    function build() {
      if (host) return;

      host = document.createElement('div');
      host.setAttribute('data-dssp-ui', '1');
      shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          *, *::before, *::after { box-sizing: border-box; }
          .launcher {
            position: fixed; z-index: 2147483000;
            width: 30px; height: 30px; padding: 0;
            border-radius: 50%;
            border: 1px solid rgba(140,140,140,.4);
            background: rgba(25,26,28,.78);
            color: #e9e9ea;
            font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
            font-size: 15px; line-height: 1;
            display: flex; align-items: center; justify-content: center;
            cursor: pointer;
            opacity: .4;
            transition: opacity .15s ease, background .15s ease;
            -webkit-user-select: none; user-select: none;
          }
          .launcher:hover, .launcher:focus-visible {
            opacity: 1; background: rgba(25,26,28,.96); outline: none;
          }
          .panel {
            position: fixed; z-index: 2147483001;
            left: 50%; top: 50%;
            transform: translate(-50%, -50%);
            width: 340px; max-width: calc(100vw - 24px);
            max-height: calc(100vh - 24px);
            overflow: auto;
            background: #1e1f22;
            color: #e8e8e9;
            border: 1px solid rgba(255,255,255,.12);
            border-radius: 14px;
            box-shadow: 0 20px 60px rgba(0,0,0,.55);
            padding: 16px;
            font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
            font-size: 13px; line-height: 1.6;
          }
          .panel[hidden] { display: none; }
          .title { font-size: 14px; font-weight: 600; margin: 0 0 12px; }
          .row { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 12px; cursor: pointer; }
          .row input[type="checkbox"] { margin: 4px 0 0; accent-color: #4d6bfe; }
          .label { font-size: 13px; }
          .prompt {
            width: 100%; min-height: 110px; resize: vertical;
            background: #141518; color: #f2f2f3;
            border: 1px solid rgba(255,255,255,.14);
            border-radius: 8px;
            padding: 9px 10px;
            font-family: inherit; font-size: 13px; line-height: 1.55;
            outline: none;
          }
          .prompt:focus { border-color: #4d6bfe; }
          .hint {
            margin-top: 8px; color: #9aa0a6;
            font-size: 11.5px; line-height: 1.5;
          }
          .status { min-height: 16px; margin-top: 4px; color: #4ed17e; font-size: 11.5px; }
        </style>
        <button type="button" class="launcher"
          title="システムプロンプト設定 (Ctrl+Alt+P)"
          aria-label="システムプロンプト設定">⚙</button>
        <div class="panel" hidden>
          <div class="title">システムプロンプト設定</div>
          <label class="row">
            <input type="checkbox" class="enabled">
            <span class="label">有効にする（各チャットの最初のメッセージのみ）</span>
          </label>
          <textarea class="prompt" spellcheck="false"
            placeholder="例: 常に日本語で答えてください。"></textarea>
          <div class="hint">
            ここに入力した文字列は &lt;instruction&gt; と &lt;/instruction&gt; で
            自動的に囲まれ、各チャットの最初のメッセージの先頭に
            「タグ付きブロック + 空行 + 本文」の形で付加されます。入力欄には表示されません。
          </div>
          <div class="status"></div>
        </div>
      `;
      document.body.appendChild(host);

      launcher = shadow.querySelector('.launcher');
      panel = shadow.querySelector('.panel');
      promptInput = shadow.querySelector('.prompt');
      enabledInput = shadow.querySelector('.enabled');
      statusEl = shadow.querySelector('.status');

      enabledInput.checked = !!settings.enabled;
      promptInput.value = String(settings.prompt || '');

      const save = debounce(() => {
        settings.enabled = enabledInput.checked;
        settings.prompt = promptInput.value;
        persistSettings();
        statusEl.textContent = '保存しました';
        setTimeout(() => {
          if (statusEl.textContent === '保存しました') statusEl.textContent = '';
        }, 1400);
      }, 250);

      enabledInput.addEventListener('change', save);
      promptInput.addEventListener('input', save);
      launcher.addEventListener('click', toggle);

      shadow.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !panel.hidden) {
          e.stopPropagation();
          close();
        }
      });

      document.addEventListener('pointerdown', (e) => {
        if (!panel || panel.hidden) return;
        if (e.composedPath().includes(host)) return;
        close();
      }, true);

      window.addEventListener('resize', positionLauncher);
      setInterval(positionLauncher, 800);
      positionLauncher();
    }

    function open() {
      build();
      enabledInput.checked = !!settings.enabled;
      promptInput.value = String(settings.prompt || '');
      panel.hidden = false;
    }

    function close() {
      if (!panel) return;
      panel.hidden = true;
      settings.enabled = enabledInput.checked;
      settings.prompt = promptInput.value;
      persistSettings();
    }

    function toggle() {
      build();
      if (panel.hidden) open();
      else close();
    }

    return { build, open, close, toggle };
  })();

  /* =========================================================
   * 起動
   * ========================================================= */
  document.addEventListener('keydown', handleKeyDown, true);
  document.addEventListener('click', handleClick, true);

  // パネル外での Esc やショートカット (Ctrl+Alt+P)
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && e.code === 'KeyP') {
      e.preventDefault();
      e.stopImmediatePropagation();
      ui.toggle();
    }
  }, true);

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('システムプロンプト設定を開く', () => ui.open());
  }

  ui.build();
})();

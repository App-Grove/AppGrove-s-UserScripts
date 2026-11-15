// ==UserScript==
// @name         Twitter/X Share Screenshot
// @namespace    net.appgrove.userscripts
// @version      1.1.9
// @description  Add a share menu item to copy the displayed post as a PNG to the clipboard
// @author       appgrove
// @license      Apache-2.0
// @homepageURL  https://github.com/App-Grove/AppGrove-s-UserScripts
// @supportURL   https://github.com/App-Grove/AppGrove-s-UserScripts/issues
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://mobile.x.com/*
// @match        https://mobile.twitter.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @connect      pbs.twimg.com
// @connect      abs.twimg.com
// @require      https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js
// @updateURL    https://raw.githubusercontent.com/App-Grove/AppGrove-s-UserScripts/main/scripts/x-share-screenshot.user.js
// ==/UserScript==

(() => {
  'use strict';

  const LABEL = 'スクリーンショット';
  const ITEM_SELECTOR = '[data-x-share-screenshot="save"]';
  const MENU_SELECTOR = '[data-testid="Dropdown"], [role="menu"]';
  const TWEET_SELECTOR = 'article[data-testid="tweet"], article[role="article"]';
  const TEXT_SELECTOR = '[data-testid="tweetText"]';
  const SHOW_MORE_SELECTOR = '[data-testid="tweet-text-show-more-link"]';
  const IMAGE_HOSTS = new Set(['pbs.twimg.com', 'abs.twimg.com']);
  const SPACING_PROPERTIES = [
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'row-gap', 'column-gap'
  ];
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CAMERA_PATH = 'M9 3 7 6H3a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-4l-2-3H9zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z';

  let activeShare = null;
  let busy = false;
  let scanQueued = false;
  let toastTimer;

  function getPostInfo(tweet) {
    // 引用先の画像リンクより、元投稿の時刻リンクを優先する。
    const links = [...tweet.querySelectorAll('a[href*="/status/"]')];
    links.sort((a, b) => Number(Boolean(b.querySelector('time'))) -
      Number(Boolean(a.querySelector('time'))));
    for (const link of links) {
      if (link.closest(TWEET_SELECTOR) !== tweet) continue;
      let url;
      try {
        url = new URL(link.href, location.href);
      } catch {
        // 不正なリンクが混在しても、後続の投稿リンクを調べる。
        continue;
      }
      const match = url.pathname.match(/^\/([\w]+)\/status\/(\d+)(?:\/|$)/);
      if (match && /^(?:(?:mobile|www)\.)?(?:x|twitter)\.com$/.test(url.hostname)) {
        return { username: match[1], id: match[2] };
      }
    }
    return null;
  }

  function isShareButton(button) {
    return /共有|share/i.test(button.getAttribute('aria-label') || '') ||
      // 添付DOMの共有アイコン。表示言語に依存しない補助判定。
      [...button.querySelectorAll('svg path')].some(path =>
        (path.getAttribute('d') || '').startsWith('M12 2.59l5.7'));
  }

  function isVisible(element) {
    return element.isConnected && element.getClientRects().length > 0;
  }

  function getTranslationRows(tweet) {
    const rows = new Map();
    const originalLabel = /^(?:原文を表示(?:する)?|原文に戻す|Show original|View original)$/i;
    const translateLabel = /^(?:ポストを翻訳|ツイートを翻訳|翻訳(?:する|を表示)?|訳文を表示|Grokで翻訳|Translate(?: (?:post|Tweet))?|Show translation|View translation)$/i;
    for (const text of tweet.querySelectorAll(TEXT_SELECTOR)) {
      // 本文に隣接する翻訳行だけを見る。本文中の語句やヘッダーのGrokボタンは対象外。
      const before = text.previousElementSibling;
      const after = text.nextElementSibling;
      for (const row of [
        before?.matches(SHOW_MORE_SELECTOR) ? before.previousElementSibling : before,
        after?.matches(SHOW_MORE_SELECTOR) ? after.nextElementSibling : after
      ]) {
        if (!row || row.matches(TEXT_SELECTOR) || row.querySelector(TEXT_SELECTOR)) continue;
        const controls = [row, ...row.querySelectorAll('button, [role="button"], a')]
          .filter(node => node.matches('button, [role="button"], a'));
        const label = node => (node.getAttribute('aria-label') || node.textContent || '')
          .replace(/\s+/g, ' ').trim();
        const originals = controls.filter(node => originalLabel.test(label(node)));
        if (originals.length) rows.set(row, { text, translated: true, controls: originals });
        else if (controls.some(node => translateLabel.test(label(node))) || row.matches('[data-testid="translate"]')) {
          rows.set(row, { text, translated: false, controls });
        }
      }
    }
    return rows;
  }

  function getCollapsedTextControls(tweet) {
    return [...tweet.querySelectorAll(SHOW_MORE_SELECTOR)].filter(node => isVisible(node) &&
      !/^(?:表示を減らす|折りたたむ|Show less)$/i.test((node.textContent || '').trim()));
  }

  async function expandPostText(context) {
    const translationState = tweet => {
      const rows = [...getTranslationRows(tweet).values()];
      return [...tweet.querySelectorAll(TEXT_SELECTOR)].map(text =>
        rows.some(state => state.text === text && state.translated)).join(',');
    };
    const translated = translationState(context.tweet);
    const findTweet = () => {
      if (context.tweet.isConnected && getPostInfo(context.tweet)?.id === context.post.id) return context.tweet;
      return [...document.querySelectorAll(TWEET_SELECTOR)].find(tweet => getPostInfo(tweet)?.id === context.post.id);
    };
    let tweet = findTweet();
    while (tweet && getCollapsedTextControls(tweet).length) {
      const control = getCollapsedTextControls(tweet)[0];
      // 詳細ページへのリンクは自動で開かず、表示状態を保ったまま展開できるボタンを使う。
      if (control.localName === 'a' ||
          (control.localName !== 'button' && control.getAttribute('role') !== 'button')) {
        throw new Error('本文を自動展開できません。投稿を開いて「さらに表示」で全文を表示してからコピーしてください');
      }
      const count = getCollapsedTextControls(tweet).length;
      control.click();
      const started = Date.now();
      let settled;
      while (true) {
        tweet = findTweet();
        const expanded = tweet && getCollapsedTextControls(tweet).length < count &&
          !tweet.querySelector('[aria-busy="true"]');
        if (expanded) {
          settled ??= Date.now();
          if (Date.now() - settled >= 300) break;
        } else settled = null;
        if (Date.now() - started >= 10000) {
          throw new Error('本文の展開を確認できませんでした。「さらに表示」で全文を表示してからコピーしてください');
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      context.tweet = tweet;
    }
    if (!tweet) throw new Error('対象の投稿が移動しました。共有メニューを開き直してください');
    if (translationState(tweet) !== translated) {
      throw new Error('本文の展開中に翻訳の表示状態が変わりました。コピーしたい本文を表示してから再度コピーしてください');
    }
    return tweet;
  }

  function preparePostText(clone) {
    for (const [row, state] of getTranslationRows(clone)) {
      if (!state.translated) {
        row.remove();
        continue;
      }
      if (state.controls.includes(row)) {
        const attribution = clone.ownerDocument.createElement('span');
        attribution.textContent = 'Grokによる翻訳';
        row.replaceWith(attribution);
        continue;
      }
      state.controls.forEach(control => control.remove());
      if (!/Grok/i.test(row.textContent || '')) {
        const attribution = clone.ownerDocument.createElement('span');
        attribution.textContent = 'Grokによる翻訳 · ';
        const icon = row.querySelector('svg');
        if (icon) icon.after(attribution);
        else row.prepend(attribution);
      }
    }
    clone.querySelectorAll(SHOW_MORE_SELECTOR).forEach(node => node.remove());
    for (const text of clone.querySelectorAll(TEXT_SELECTOR)) {
      // 本文の行数制限と、その祖先の固定高さを複製側だけで解除する。
      for (const node of [text, ...text.querySelectorAll('*')]) {
        for (const [name, value] of Object.entries({
          'max-height': 'none', overflow: 'visible', 'text-overflow': 'clip',
          'white-space': 'pre-wrap', 'overflow-wrap': 'anywhere',
          '-webkit-line-clamp': 'unset', 'line-clamp': 'unset'
        })) node.style.setProperty(name, value, 'important');
      }
      text.style.setProperty('display', 'block', 'important');
      text.style.setProperty('white-space', 'pre-wrap', 'important');
      text.style.setProperty('overflow-wrap', 'anywhere', 'important');
      for (let node = text; node; node = node.parentElement) {
        node.style.setProperty('height', 'auto', 'important');
        node.style.setProperty('max-height', 'none', 'important');
        // 横並びの幅調整や引用カードの角丸クリップは維持する。
        // 縦並びのflex項目だけ、展開した本文が高さ方向に縮まないようにする。
        const parentStyle = node.parentElement && clone.ownerDocument.defaultView.getComputedStyle(node.parentElement);
        if (parentStyle && ['flex', 'inline-flex'].includes(parentStyle.display) &&
            ['column', 'column-reverse'].includes(parentStyle.flexDirection)) {
          node.style.setProperty('flex-shrink', '0', 'important');
        }
        if (node === clone) break;
      }
    }
  }

  function showToast(message, duration = 4000) {
    let toast = document.getElementById('x-share-screenshot-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'x-share-screenshot-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('data-html2canvas-ignore', 'true');
      toast.style.cssText = 'position:fixed;left:50%;bottom:72px;transform:translateX(-50%);' +
        'z-index:2147483647;padding:12px 16px;border-radius:8px;background:#202124;' +
        'color:#fff;font:14px/1.5 sans-serif;max-width:85vw;pointer-events:none';
      document.documentElement.appendChild(toast);
    }
    toast.textContent = message;
    clearTimeout(toastTimer);
    if (duration) toastTimer = setTimeout(() => toast.remove(), duration);
  }

  function createMenuItem(template) {
    // cloneNodeしない。URL Improverのdata-fixupx-kindやイベントを引き継がない。
    const item = document.createElement('div');
    item.dataset.xShareScreenshot = 'save';
    item.setAttribute('role', 'menuitem');
    item.setAttribute('aria-label', LABEL);
    item.tabIndex = 0;
    item.className = template.className;
    const style = getComputedStyle(template);
    item.style.cssText = 'display:flex;flex-direction:row;align-items:center;gap:12px;' +
      'padding:12px 16px;min-height:48px;box-sizing:border-box;cursor:pointer;' +
      'white-space:nowrap;background:transparent;outline-offset:-3px';
    item.style.color = style.color;
    item.style.font = style.font;
    item.style.fontWeight = '700';
    item.addEventListener('mouseenter', () => { item.style.backgroundColor = 'rgba(127,127,127,.12)'; });
    item.addEventListener('mouseleave', () => { item.style.backgroundColor = 'transparent'; });

    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.style.cssText = 'width:20px;height:20px;flex:none;fill:currentColor';
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', CAMERA_PATH);
    icon.appendChild(path);
    const label = document.createElement('span');
    label.textContent = LABEL;
    item.append(icon, label);
    return item;
  }

  function scanMenus() {
    scanQueued = false;
    if (!activeShare?.tweet.isConnected || !activeShare.button.isConnected) return;
    for (const menu of document.querySelectorAll(MENU_SELECTOR)) {
      if (!isVisible(menu)) continue;
      // Dropdownとmenuが入れ子の場合も、共有メニュー全体で重複を確認する。
      let root = menu;
      while (root.parentElement?.closest(MENU_SELECTOR)) {
        root = root.parentElement.closest(MENU_SELECTOR);
      }
      const screenshotItems = [...root.querySelectorAll('[role="menuitem"]')].filter(item =>
        item.matches(ITEM_SELECTOR) ||
        (item.textContent || '').replace(/\s+/g, ' ').trim() === LABEL);
      const otherItem = screenshotItems.find(item => !item.matches(ITEM_SELECTOR));
      const keep = otherItem || screenshotItems[0];
      screenshotItems.forEach(item => {
        if (item !== keep && item.matches(ITEM_SELECTOR)) item.remove();
      });
      const items = [...menu.querySelectorAll('[role="menuitem"]')].filter(item =>
        item.closest(MENU_SELECTOR) === menu);
      if (!items.length || keep) continue;
      // 再利用されたDOMや別メニューには挿入しない。既存スクリプトの処理順にも依存しない。
      const copyItem = items.find(item => item.dataset.fixupxKind === 'normal' ||
        /^(リンクをコピー|ポストのリンクをコピー|Copy link(?: to (?:post|Tweet))?)$/i.test(
          (item.textContent || '').replace(/\s+/g, ' ').trim()) ||
        item.querySelector('[data-testid="icon-link"]'));
      if (!copyItem) continue;
      const item = createMenuItem(copyItem);
      item.setAttribute('aria-disabled', String(busy));
      copyItem.parentElement.appendChild(item);
    }
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    queueMicrotask(scanMenus);
  }

  function closeMenu(item, context) {
    let menu = item.closest(MENU_SELECTOR);
    while (menu?.parentElement?.closest(MENU_SELECTOR)) {
      menu = menu.parentElement.closest(MENU_SELECTOR);
    }
    // X側の終了処理が非同期でも、クリック直後の描画ではメニューを隠す。
    const previousVisibility = menu?.style.visibility;
    if (menu) menu.style.visibility = 'hidden';
    item.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', bubbles: true, cancelable: true
    }));
    setTimeout(() => {
      if (menu && isVisible(menu) && context.button.isConnected) {
        context.button.click();
      }
      // Xが同じDOMを再利用する場合に備えて、元の表示設定を戻す。
      if (menu) setTimeout(() => { menu.style.visibility = previousVisibility; }, 200);
    }, 50);
  }

  function afterFeedbackPaint() {
    return new Promise(resolve => {
      let frame;
      const finish = () => {
        clearTimeout(timer);
        cancelAnimationFrame(frame);
        resolve();
      };
      // バックグラウンドタブでは描画を待ち続けない。
      const timer = setTimeout(finish, 100);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
    });
  }

  function highlightPost(tweet) {
    const rect = tweet.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const highlight = document.createElement('div');
    highlight.setAttribute('aria-hidden', 'true');
    highlight.setAttribute('data-html2canvas-ignore', 'true');
    highlight.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;` +
      `width:${rect.width}px;height:${rect.height}px;box-sizing:border-box;` +
      'border:2px solid rgba(29,155,240,.55);border-radius:8px;' +
      'background:rgba(29,155,240,.08);pointer-events:none;z-index:2147483646';
    document.documentElement.appendChild(highlight);
    setTimeout(() => highlight.remove(), 550);
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches && highlight.animate) {
      highlight.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 550, easing: 'ease-out' });
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('画像の変換に失敗しました'));
      reader.readAsDataURL(blob);
    });
  }

  async function loadImageData(source) {
    const url = new URL(source, location.href);
    if (url.protocol === 'data:') return source;
    if (url.protocol === 'blob:') {
      const response = await fetch(url.href);
      return blobToDataUrl(await response.blob());
    }
    if (url.protocol !== 'https:' || !IMAGE_HOSTS.has(url.hostname)) {
      const error = new Error(`画像の配信元に対応していません (${url.protocol}//${url.host})`);
      error.imageUrl = url.href;
      throw error;
    }
    // 画像をデータURLにして、CORSによる画像欠落やtainted canvasを避ける。
    const blob = await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: url.href, responseType: 'arraybuffer',
        anonymous: true, timeout: 15000,
        onload(response) {
          try {
            const type = (response.responseHeaders || '').match(/^content-type:\s*([^;\r\n]+)/im)?.[1];
            if (response.status < 200 || response.status >= 300 || !/^image\//i.test(type || '')) {
              throw new Error('画像を取得できませんでした。再読み込みしてお試しください');
            }
            resolve(new Blob([response.response], { type }));
          } catch (error) {
            // 非同期コールバック内の例外も取得失敗として呼び出し元へ返す。
            reject(error);
          }
        },
        onerror: () => reject(new Error('画像の取得に失敗しました')),
        ontimeout: () => reject(new Error('画像の取得がタイムアウトしました')),
        onabort: () => reject(new Error('画像の取得が中断されました'))
      });
    });
    return blobToDataUrl(blob);
  }

  function getBackgroundColor(element) {
    for (let node = element; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color;
    }
    return '#fff';
  }

  function getVideoFrames(tweet) {
    return [...tweet.querySelectorAll('video')].map(video => {
      if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
        try {
          const frame = document.createElement('canvas');
          frame.width = video.videoWidth;
          frame.height = video.videoHeight;
          frame.getContext('2d').drawImage(video, 0, 0);
          return frame.toDataURL('image/png');
        } catch {
          // クロスオリジン動画は現在フレームを取り出せないことがある。
        }
      }
      return video.poster || null;
    });
  }

  function getBackgroundUrls(background) {
    // CSS文字列のエスケープを保持して切り出す。SVG内の引用符・括弧でURLを分断しない。
    const pattern = /\burl\(\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|((?:\\[\s\S]|[^"'()\\])*))\s*\)/gi;
    return [...background.matchAll(pattern)].map(match => {
      const value = match[1] ?? match[2] ?? match[3].trim();
      const source = value.replace(/\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|(\r\n|[\r\n\f])|([\s\S]))/gi,
        (_, hex, newline, character) => {
          if (hex) {
            const point = parseInt(hex, 16);
            return !point || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)
              ? '\ufffd' : String.fromCodePoint(point);
          }
          return newline ? '' : character;
        });
      return { original: match[0], source };
    });
  }

  function toCssUrl(source) {
    const escaped = source.replace(/[\x00-\x1f\x7f"\\]/g,
      character => `\\${character.codePointAt(0).toString(16)} `);
    return `url("${escaped}")`;
  }

  function isExtensionResource(source) {
    return /^(?:moz|chrome)-extension:/i.test(source || '');
  }

  function setImageSource(image, data, source) {
    // picture/sourceが残るとimg.srcをデータURLにしても別の画像が選択される。
    if (image.parentElement?.localName === 'picture') {
      image.parentElement.querySelectorAll('source').forEach(element => element.remove());
    }
    image.removeAttribute('srcset');
    image.removeAttribute('sizes');
    image.removeAttribute('crossorigin');
    image.loading = 'eager';
    return new Promise((resolve, reject) => {
      let settled = false;
      let checkTimer;
      let timeout;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(checkTimer);
        clearTimeout(timeout);
        image.removeEventListener('load', check);
        image.removeEventListener('error', check);
        if (error) reject(error);
        else resolve();
      };
      const failure = message => {
        const error = new Error(message);
        error.imageUrl = source;
        error.stage = 'image-load';
        return error;
      };
      const check = () => {
        if (!image.complete) return;
        finish(image.naturalWidth > 0 && image.naturalHeight > 0
          ? null : failure('画像を読み込めませんでした（画像データまたはブラウザーの画像制限を確認してください）'));
      };
      image.addEventListener('load', check);
      image.addEventListener('error', check);
      timeout = setTimeout(() => finish(failure('画像の読み込みがタイムアウトしました')), 15000);
      image.src = data;
      // src更新の反映を待つ。decode()を直後に呼ぶとFirefoxで古い画像要求に対して失敗しうる。
      checkTimer = setTimeout(check, 0);
    });
  }

  function prepareAvatars(clone) {
    for (const avatar of clone.querySelectorAll('[data-testid^="UserAvatar-Container-"]')) {
      for (const node of [avatar, ...avatar.querySelectorAll('*')]) {
        const style = clone.ownerDocument.defaultView.getComputedStyle(node);
        if (style.transform === 'none' || !['absolute', 'fixed', 'relative'].includes(style.position)) continue;
        const matrix = new DOMMatrixReadOnly(style.transform);
        // html2canvasでは、平行移動された要素の丸いクリップと子画像の位置がずれる。
        // 回転・拡縮は変えず、撮影用DOMの平行移動だけをleft/topに置き換える。
        if (matrix.a !== 1 || matrix.b !== 0 || matrix.c !== 0 || matrix.d !== 1 ||
            matrix.m13 !== 0 || matrix.m14 !== 0 || matrix.m23 !== 0 || matrix.m24 !== 0 ||
            matrix.m31 !== 0 || matrix.m32 !== 0 || matrix.m33 !== 1 || matrix.m34 !== 0 ||
            matrix.m43 !== 0 || matrix.m44 !== 1 ||
            (!matrix.e && !matrix.f)) continue;
        const offset = (start, end) => {
          const value = parseFloat(start);
          return Number.isFinite(value) ? value : -(parseFloat(end) || 0);
        };
        const left = offset(style.left, style.right) + matrix.e;
        const top = offset(style.top, style.bottom) + matrix.f;
        // 両端指定や自動サイズでも、配置の補正でアイコンの寸法が変わらないようにする。
        const width = style.width;
        const height = style.height;
        for (const [name, value] of Object.entries({
          width, height, left: `${left}px`, top: `${top}px`,
          right: 'auto', bottom: 'auto', transform: 'none'
        })) node.style.setProperty(name, value, 'important');
      }
    }
  }

  function removeCaptureControls(clone) {
    for (const avatar of clone.querySelectorAll('[data-testid="Tweet-User-Avatar"]')) {
      // アバター列の空の細線だけを隠す。領域を残し、本文や画像の配置は変えない。
      for (const line of avatar.parentElement.children) {
        if (line === avatar || !line.matches('div:empty')) continue;
        const { width, height } = line.getBoundingClientRect();
        if (width > 0 && width <= 2 && height > width) {
          line.style.setProperty('visibility', 'hidden', 'important');
        }
      }
    }
    for (const context of clone.querySelectorAll('[data-testid="socialContext"]')) {
      let row = context;
      // リポストのアイコンと余白も含め、投稿内容に達する手前までの行を除く。
      const content = '[data-testid="User-Name"], [data-testid="tweetText"], ' +
        '[data-testid^="UserAvatar-Container-"], a[href*="/status/"], ' +
        'button, [role="button"], [role="group"], img, video';
      while (row.parentElement && row.parentElement !== clone &&
          row.parentElement.textContent.trim() === context.textContent.trim() &&
          !row.parentElement.querySelector(content)) {
        row = row.parentElement;
      }
      const repost = /リポスト|リツイート|\bre(?:post|tweet)ed\b/i.test(context.textContent) ||
        [...row.querySelectorAll('svg path')].some(path =>
          /^(?:M4\.75 3\.79|M4\.5 3\.88)/.test(path.getAttribute('d') || ''));
      if (repost) row.remove();
    }
    for (const button of clone.querySelectorAll('button, [role="button"]')) {
      if (!button.matches('[data-testid="bookmark"], [data-testid="removeBookmark"]') &&
          !isShareButton(button)) continue;
      let target = button;
      // ボタンだけを包む要素も除き、操作欄に空の枠を残さない。
      while (target.parentElement && target.parentElement !== clone &&
          !target.parentElement.matches(`${TWEET_SELECTOR}, [role="group"]`) &&
          target.parentElement.children.length === 1 &&
          target.parentElement.textContent.trim() === button.textContent.trim()) {
        target = target.parentElement;
      }
      target.remove();
    }
  }

  function prepareFocusedPost(clone) {
    const name = clone.querySelector('[data-testid="User-Name"]');
    const avatar = clone.querySelector('[data-testid="Tweet-User-Avatar"]');
    const time = [...clone.querySelectorAll('time')].find(node => !name?.contains(node));
    const reply = clone.querySelector('[data-testid="reply"]');
    const group = reply?.closest('[role="group"]');
    if (!name || !avatar || !time || !group) return;

    // 詳細表示ではヘッダーの隣ではなく、その下に本文・日時・操作欄がある。
    const header = [...clone.querySelectorAll('div')].find(node =>
      node.contains(avatar) && node.contains(name) && !node.contains(time));
    if (!header) return;
    let body = time;
    while (body.parentElement && body.parentElement !== header.parentElement) body = body.parentElement;
    if (body.parentElement !== header.parentElement || body === header || !body.contains(group)) return;
    let metadata = time;
    while (metadata.parentElement && metadata.parentElement !== body) metadata = metadata.parentElement;
    if (metadata.parentElement !== body) return;
    const column = [...header.children].find(node => node.contains(name));
    if (!column) return;

    const date = new Date(time.dateTime);
    const elapsed = (Date.now() - date.getTime()) / 1000;
    if (Number.isFinite(elapsed) && elapsed >= 0) {
      const locale = clone.ownerDocument.documentElement.lang || navigator.language;
      const unit = elapsed < 60 ? 'second' : elapsed < 3600 ? 'minute' : elapsed < 86400 ? 'hour' : 'day';
      const divisor = { second: 1, minute: 60, hour: 3600, day: 86400 }[unit];
      const label = elapsed < 86400 * 7
        ? new Intl.RelativeTimeFormat(locale, { style: 'short' }).format(-Math.floor(elapsed / divisor), unit)
        : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric',
          ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }).format(date);
      const stamp = clone.ownerDocument.createElement('span');
      stamp.textContent = ` · ${label}`;
      stamp.style.cssText = 'color:rgb(113,118,123);white-space:nowrap';
      name.appendChild(stamp);
    }
    name.style.setProperty('display', 'flex', 'important');
    name.style.setProperty('flex-direction', 'row', 'important');
    name.style.setProperty('align-items', 'baseline', 'important');
    name.style.setProperty('gap', '4px', 'important');
    for (const child of name.children) {
      child.style.setProperty('width', 'auto', 'important');
      child.style.setProperty('flex-shrink', '1', 'important');
    }

    const viewLink = metadata.querySelector('a[href*="/analytics"]');
    const viewCount = group.getAttribute('aria-label')?.match(/([\d,]+)\s*(?:件の表示|views?)/i)?.[1];
    if (viewLink && viewCount) {
      const view = clone.ownerDocument.createElement('div');
      view.dataset.xScreenshotViews = '';
      const count = Number(viewCount.replace(/,/g, ''));
      const locale = clone.ownerDocument.documentElement.lang || navigator.language;
      const reference = reply.querySelector('svg') || reply;
      const color = clone.ownerDocument.defaultView.getComputedStyle(reference).color;
      view.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:13px';
      view.style.setProperty('color', color, 'important');
      view.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:18px;height:18px"><path d="M8.75 21V3h2v18h-2zm-4-3V8h2v10h-2zm8 0v-7h2v7h-2zm4 3V5h2v16h-2z"/></svg>';
      view.querySelector('path').setAttribute('fill', color);
      const value = clone.ownerDocument.createElement('span');
      value.style.setProperty('color', color, 'important');
      value.textContent = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 0 }).format(count);
      view.appendChild(value);
      group.appendChild(view);
    }
    group.style.setProperty('border', '0', 'important');
    group.style.setProperty('padding', '0', 'important');
    group.style.setProperty('margin-top', '12px', 'important');
    group.style.setProperty('justify-content', 'space-between', 'important');
    let hasText = false;
    while (body.firstElementChild && body.firstElementChild !== metadata) {
      const content = body.firstElementChild;
      // 本文の後の画像は、元の余白を尊重しつつ最低限の間隔を確保する。
      const isPhoto = content.matches('[data-testid="tweetPhoto"]') ||
        content.querySelector('[data-testid="tweetPhoto"]');
      const margin = hasText && isPhoto
        ? Math.max(12, parseFloat(clone.ownerDocument.defaultView.getComputedStyle(content).marginTop) || 0)
        : 0;
      content.style.setProperty('margin-top', `${margin}px`, 'important');
      hasText ||= content.matches(TEXT_SELECTOR) || Boolean(content.querySelector(TEXT_SELECTOR));
      column.appendChild(content);
    }
    column.appendChild(group);
    const text = column.querySelector(TEXT_SELECTOR);
    if (text) {
      text.style.setProperty('font-size', '15px', 'important');
      text.style.setProperty('line-height', '20px', 'important');
    }
    body.remove();
  }

  function alignActionBar(clone) {
    for (const reply of clone.querySelectorAll('[data-testid="reply"]')) {
      const group = reply.closest('[role="group"]');
      if (!group) continue;
      const controls = [reply,
        group.querySelector('[data-testid="retweet"], [data-testid="unretweet"]'),
        group.querySelector('[data-testid="like"], [data-testid="unlike"]'),
        group.querySelector('[data-x-screenshot-views], a[href*="/analytics"]')];
      if (controls.some(control => !control)) continue;
      const columns = controls.map(control => {
        let node = control;
        while (node.parentElement && node.parentElement !== group) node = node.parentElement;
        return node.parentElement === group ? node : null;
      });
      if (columns.some(column => !column) || new Set(columns).size !== 4 ||
          group.children.length !== 4) continue;
      group.style.setProperty('display', 'grid', 'important');
      group.style.setProperty('grid-template-columns', 'repeat(4, minmax(0, 1fr))', 'important');
      group.style.setProperty('column-gap', '0', 'important');
      group.style.setProperty('width', '100%', 'important');
      group.style.setProperty('max-width', 'none', 'important');
      group.style.setProperty('height', '20px', 'important');
      group.style.setProperty('min-height', '0', 'important');
      group.style.setProperty('margin-top', '12px', 'important');
      group.style.setProperty('align-items', 'center', 'important');
      for (const column of columns) {
        column.style.setProperty('justify-self', 'start', 'important');
        column.style.setProperty('min-width', '0', 'important');
      }
      for (const control of controls) {
        control.style.setProperty('height', '20px', 'important');
        control.style.setProperty('min-height', '0', 'important');
        control.style.setProperty('padding', '0', 'important');
        for (const svg of control.querySelectorAll('svg')) {
          svg.style.setProperty('width', '18px', 'important');
          svg.style.setProperty('height', '18px', 'important');
        }
        for (const span of control.querySelectorAll('span')) {
          span.style.setProperty('font-size', '13px', 'important');
          span.style.setProperty('line-height', '16px', 'important');
        }
      }
    }
  }

  function getSpacingChildren(element) {
    // html2canvasが省略する要素と、複製時に追加する疑似要素を対応付けから除く。
    return [...element.children].filter(child => child.localName !== 'script' &&
      child.localName !== 'html2canvaspseudoelement' && !child.hasAttribute('data-html2canvas-ignore'));
  }

  function snapshotSpacing(element) {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return {
      tag: element.localName, id: element.id, testId: element.getAttribute('data-testid'),
      values: SPACING_PROPERTIES.map(name => style.getPropertyValue(name)),
      children: getSpacingChildren(element).map(snapshotSpacing)
    };
  }

  function restoreSpacing(element, snapshot) {
    if (!snapshot || element.localName !== snapshot.tag || element.id !== snapshot.id ||
        element.getAttribute('data-testid') !== snapshot.testId) return;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    SPACING_PROPERTIES.forEach((name, index) => {
      const value = snapshot.values[index];
      if (value && style.getPropertyValue(name) !== value) {
        element.style.setProperty(name, value, 'important');
      }
    });
    getSpacingChildren(element).forEach((child, index) => restoreSpacing(child, snapshot.children[index]));
  }

  async function prepareClone(clonedDocument, clone, snapshot) {
    // 仮想スクロールのtransform・クリップ・画面外の位置から切り離す。元のDOMは変更しない。
    const wrapper = clonedDocument.createElement('div');
    wrapper.style.cssText = 'position:absolute;left:0;top:0;margin:0;padding:0;' +
      'overflow:visible;z-index:2147483647';
    wrapper.style.width = `${snapshot.width}px`;
    wrapper.style.font = snapshot.font;
    wrapper.style.color = snapshot.color;
    wrapper.style.backgroundColor = snapshot.background;
    wrapper.dir = snapshot.direction;
    clonedDocument.body.appendChild(wrapper);
    wrapper.appendChild(clone);
    clone.style.setProperty('width', `${snapshot.width}px`, 'important');
    clone.style.setProperty('box-sizing', 'border-box', 'important');
    clone.style.setProperty('transform', 'none', 'important');
    // 複製時のCSS欠落や親要素からの切り離しで変化した余白だけ、元の投稿の値へ戻す。
    // 引用ヘッダー・本文の左右marginと本文下のmarginも含めて保持する。
    restoreSpacing(clone, snapshot.spacing);
    clone.style.setProperty('margin', '0', 'important');
    clone.style.backgroundColor = snapshot.background;

    prepareFocusedPost(clone);
    removeCaptureControls(clone);
    alignActionBar(clone);
    preparePostText(clone);
    prepareAvatars(clone);

    // CSLTの報告ボタンは拡張機能内のreport_icon.svgを使う。投稿内容と分け、複製からだけ除く。
    clone.querySelectorAll('[cslt_report_btn], .cslt_report_icon').forEach(element => {
      element.remove();
      snapshot.excludedExtensionUi = true;
    });
    for (const image of clone.querySelectorAll('img')) {
      if (isExtensionResource(image.currentSrc || image.src)) {
        image.remove();
        snapshot.excludedExtensionUi = true;
      }
    }

    // html2canvasは動画を直接描画しないため、複製側だけを静止画にする。
    [...clone.querySelectorAll('video')].forEach((video, index) => {
      const replacement = clonedDocument.createElement(snapshot.frames[index] ? 'img' : 'div');
      replacement.style.cssText = video.style.cssText;
      replacement.className = video.className;
      const rect = snapshot.videoSizes[index];
      replacement.style.width = `${rect.width}px`;
      replacement.style.height = `${rect.height}px`;
      replacement.style.objectFit = 'contain';
      if (snapshot.frames[index]) {
        replacement.src = snapshot.frames[index];
        replacement.alt = '動画の静止画';
      } else {
        replacement.textContent = '動画（静止画を取得できませんでした）';
        replacement.style.background = '#202124';
        replacement.style.color = '#fff';
      }
      video.replaceWith(replacement);
    });

    const cache = new Map();
    const getData = source => {
      if (!cache.has(source)) {
        cache.set(source, (async () => {
          try {
            const data = await loadImageData(source);
            // 背景画像も含めてデータを検証し、読み込めない画像のURLを保持する。
            await setImageSource(clonedDocument.createElement('img'), data, source);
            return data;
          } catch (cause) {
            const error = new Error(cause.message || String(cause), { cause });
            error.imageUrl = cause.imageUrl || source;
            error.stage = cause.stage || 'image-fetch';
            throw error;
          }
        })());
      }
      return cache.get(source);
    };
    const tasks = [];
    // src=""のimg.srcはページURLになることがある。画像リソースがない要素は取得・decodeしない。
    const images = [...clone.querySelectorAll('img')].filter(image =>
      image.getAttribute('src')?.trim() || image.getAttribute('srcset')?.trim());
    for (const image of images) {
      const source = image.currentSrc || image.src;
      if (!source) continue;
      tasks.push(getData(source).then(data => setImageSource(image, data, source)));
    }
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
      const background = clonedDocument.defaultView.getComputedStyle(node).backgroundImage;
      const matches = getBackgroundUrls(background);
      if (!matches.length) continue;
      tasks.push(Promise.all(matches.map(async match => {
        const extensionResource = isExtensionResource(match.source);
        if (extensionResource) snapshot.excludedExtensionUi = true;
        return {
          original: match.original,
          // html2canvasは先頭がnoneだと全レイヤーを落とすため、透明なレイヤーで置き換える。
          css: match.source && !extensionResource
            ? toCssUrl(await getData(match.source)) : 'linear-gradient(transparent, transparent)'
        };
      })).then(replacements => {
        let updated = background;
        for (const replacement of replacements) {
          updated = updated.replace(replacement.original, () => replacement.css);
        }
        node.style.backgroundImage = updated;
      }));
    }
    // 取得に失敗した画像がある場合、欠落したPNGを黙ってコピーせずエラーを表示する。
    const results = await Promise.allSettled(tasks);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  function renderWithFirefoxCompat(tweet, options) {
    if (!document.wrappedJSObject) return html2canvas(tweet, options);

    // Firefoxの拡張機能コンテキストでは、Xray越しのdocument.open/writeが失敗する。
    // 複製iframeの該当メソッドだけをページ側のネイティブメソッドに委譲する。
    // DOMとイベントハンドラーはXrayのまま保持する（要素全体をunwrapしない）。
    const descriptor = Object.getOwnPropertyDescriptor(document, 'createElement');
    const createElement = document.createElement;
    const getWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow').get;
    const adapted = new WeakSet();
    Object.defineProperty(document, 'createElement', {
      configurable: true,
      value(...args) {
        const element = Reflect.apply(createElement, this, args);
        if (String(args[0]).toLowerCase() !== 'iframe') return element;
        Object.defineProperty(element, 'contentWindow', {
          configurable: true,
          get() {
            const view = getWindow.call(element);
            const doc = view?.document;
            if (doc?.wrappedJSObject && !adapted.has(doc)) {
              for (const method of ['open', 'write', 'close']) {
                const original = doc.wrappedJSObject[method];
                Object.defineProperty(doc, method, {
                  configurable: true,
                  value: (...values) => Reflect.apply(original, doc.wrappedJSObject, values)
                });
              }
              adapted.add(doc);
            }
            return view;
          }
        });
        return element;
      }
    });
    try {
      // html2canvas 1.4.1はPromiseを返す前に複製iframeを作る。直後に生成メソッドを戻す。
      return html2canvas(tweet, options);
    } finally {
      if (descriptor) Object.defineProperty(document, 'createElement', descriptor);
      else delete document.createElement;
    }
  }

  async function capturePost(context) {
    const { post } = context;
    if (!context.tweet.isConnected || getPostInfo(context.tweet)?.id !== post.id) {
      throw new Error('対象の投稿が移動しました。共有メニューを開き直してください');
    }
    if (typeof html2canvas !== 'function') throw new Error('描画ライブラリを読み込めませんでした');
    const tweet = await expandPostText(context);
    const style = getComputedStyle(tweet);
    const width = Math.ceil(tweet.getBoundingClientRect().width);
    const height = Math.ceil(Math.max(tweet.getBoundingClientRect().height, tweet.scrollHeight));
    if (!width || !height) throw new Error('投稿が表示されていません');
    const snapshot = {
      width, font: style.font, color: style.color, direction: style.direction,
      spacing: snapshotSpacing(tweet),
      background: getBackgroundColor(tweet), frames: getVideoFrames(tweet),
      excludedExtensionUi: false,
      videoSizes: [...tweet.querySelectorAll('video')].map(video => video.getBoundingClientRect())
    };
    let canvas;
    let cloneFrame;
    const options = {
      backgroundColor: snapshot.background,
      allowTaint: false, useCORS: true, logging: false, imageTimeout: 15000,
      onclone: async (doc, clone) => {
        cloneFrame = doc.defaultView.frameElement;
        await prepareClone(doc, clone, snapshot);
        // 展開後の高さで解像度を決める。html2canvasはonclone完了後にscaleを参照する。
        const rect = clone.getBoundingClientRect();
        const fullHeight = Math.ceil(Math.max(rect.height, clone.scrollHeight));
        options.height = fullHeight;
        options.scale = Math.min(2, 16000 / width, 16000 / fullHeight,
          Math.sqrt(16000000 / (width * fullHeight)));
      }
    };
    try {
      canvas = await renderWithFirefoxCompat(tweet, options);
    } finally {
      // oncloneの失敗時もhtml2canvasの一時iframeを残さない。
      cloneFrame?.remove();
    }
    const blob = await new Promise((resolve, reject) => canvas.toBlob(result => {
      if (result) resolve(result);
      else reject(new Error('PNG画像を生成できませんでした'));
    }, 'image/png'));
    return { blob, excludedExtensionUi: snapshot.excludedExtensionUi };
  }

  async function copyPostToClipboard(context) {
    if (!navigator.clipboard?.write || typeof ClipboardItem !== 'function') {
      throw new Error('このブラウザーは画像のクリップボードコピーに対応していません');
    }
    // Clipboard APIはユーザー操作中に呼び、画像生成はフィードバックの描画後に始める。
    const capture = afterFeedbackPaint().then(() => capturePost(context));
    const image = capture.then(result => result.blob);
    // 権限拒否などでブラウザーが画像を受け取らない場合も、描画失敗を未処理にしない。
    image.catch(() => {});
    try {
      // 描画完了を待たず、クリック・キー操作の直後に書き込みを開始する。
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]);
    } catch (error) {
      // 描画の後始末を待ち、画像取得などが失敗した場合は元のエラーを通知する。
      await capture;
      if (error.name === 'NotAllowedError') {
        throw new Error('クリップボードへの書き込みが許可されていません。Xのタブを開いた状態で、ブラウザーの権限設定を確認して再度お試しください');
      }
      throw error;
    }
    return capture;
  }

  async function activateItem(item) {
    if (busy) return;
    const context = activeShare;
    if (!context) {
      showToast('共有メニューを開き直してください');
      return;
    }
    busy = true;
    try {
      document.querySelectorAll(ITEM_SELECTOR).forEach(node => node.setAttribute('aria-disabled', 'true'));
      showToast('スクリーンショットを作成しています…', 0);
      highlightPost(context.tweet);
      closeMenu(item, context);
      await copyPostToClipboard(context);
      showToast('コピーしました');
    } catch (error) {
      if (error.imageUrl) {
        console.error('[x-share-screenshot]', error, { imageUrl: error.imageUrl, stage: error.stage });
      } else {
        console.error('[x-share-screenshot]', error);
      }
      showToast(`コピーに失敗しました: ${error.message}`, 7000);
    } finally {
      busy = false;
      document.querySelectorAll(ITEM_SELECTOR).forEach(node => node.setAttribute('aria-disabled', 'false'));
    }
  }

  document.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return;
    const item = event.target.closest(ITEM_SELECTOR);
    if (item) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void activateItem(item);
      return;
    }
    const button = event.target.closest('button[aria-haspopup="menu"]');
    if (button && isShareButton(button)) {
      const tweet = button.closest(TWEET_SELECTOR);
      const post = tweet && getPostInfo(tweet);
      activeShare = post ? { tweet, button, post } : null;
      queueScan();
    } else if (!event.target.closest(MENU_SELECTOR)) {
      activeShare = null;
    }
  }, true);

  document.addEventListener('keydown', event => {
    if (!(event.target instanceof Element)) return;
    const item = event.target.closest(ITEM_SELECTOR);
    if (item && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void activateItem(item);
    } else if (event.key === 'Escape') {
      activeShare = null;
    }
  }, true);

  new MutationObserver(queueScan).observe(document.documentElement, {
    childList: true, subtree: true
  });
})();

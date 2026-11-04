// ==UserScript==
// @name         X Search Auto Exclude Retweet
// @namespace    net.appgrove.userscripts
// @version      1.0.1
// @description  Automatically appends "-filter:retweets" to search queries on X/Twitter to exclude retweets from search results.
// @author       appgrove
// @license      Apache-2.0
// @homepageURL  https://github.com/App-Grove/AppGrove-s-UserScripts
// @supportURL   https://github.com/App-Grove/AppGrove-s-UserScripts/issues
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/App-Grove/AppGrove-s-UserScripts/main/scripts/x-search-auto-exclude-retweet.user.js
// ==/UserScript==

(() => {
    'use strict';

    const FLAG = '-filter:retweets';
    const SEARCH_INPUT = 'input[data-testid="SearchBox_Search_Input"]';

    /**
     * 検索文字列にフィルターを追加する。
     * すでに存在する場合は何もしない。
     */
    function appendFilter(query) {
        const value = query.trim();

        if (!value || /(?:^|\s)-filter:retweets(?=$|\s)/i.test(value)) {
            return value;
        }

        return `${value} ${FLAG}`;
    }

    /**
     * Reactが管理するinputの値を安全に変更する。
     */
    function updateInput(input) {
        if (!(input instanceof HTMLInputElement)) return;
        if (new URL(location.href).searchParams.get('f') === 'user') return;

        const current = input.value;
        const updated = appendFilter(current);

        if (current === updated) return;

        const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value'
        ).set;

        setter.call(input, updated);

        input.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: FLAG
        }));
    }

    /**
     * Enterによる検索実行時に処理する。
     * IME変換中のEnterには反応しない。
     */
    document.addEventListener('keydown', (event) => {
        if (
            event.key !== 'Enter' ||
            event.isComposing ||
            event.keyCode === 229
        ) {
            return;
        }

        const input = event.target;

        if (input instanceof HTMLInputElement &&
            input.matches(SEARCH_INPUT)) {
            updateInput(input);
        }
    }, true);

    /**
     * フォーム送信時のフォールバック。
     */
    document.addEventListener('submit', (event) => {
        const form = event.target;

        if (!(form instanceof HTMLFormElement)) return;

        const input = form.querySelector(SEARCH_INPUT);

        if (input) {
            updateInput(input);
        }
    }, true);

    /**
     * SPAのURL遷移にも対応する。
     * 検索URLのqパラメータを確認してフィルターを追加する。
     */
    function rewriteSearchURL(rawURL) {
        if (rawURL == null) return rawURL;

        try {
            const url = new URL(rawURL, location.href);

            if (
                !/(^|\.)((x|twitter)\.com)$/i.test(url.hostname) ||
                !url.pathname.startsWith('/search') ||
                url.searchParams.get('f') === 'user'
            ) {
                return rawURL;
            }

            const query = url.searchParams.get('q');

            if (!query) return rawURL;

            const updated = appendFilter(query);

            if (query === updated) return rawURL;

            url.searchParams.set('q', updated);
            return url.href;
        } catch {
            return rawURL;
        }
    }

    // pushState / replaceStateを監視
    for (const method of ['pushState', 'replaceState']) {
        const original = history[method];

        history[method] = function (state, title, url) {
            const rewrittenURL = rewriteSearchURL(url);

            return Reflect.apply(original, this, [
                state,
                title,
                rewrittenURL
            ]);
        };
    }

    // スクリプト実行時点ですでに検索ページにいる場合
    const initialURL = rewriteSearchURL(location.href);

    if (initialURL !== location.href) {
        history.replaceState(history.state, '', initialURL);
    }
})();

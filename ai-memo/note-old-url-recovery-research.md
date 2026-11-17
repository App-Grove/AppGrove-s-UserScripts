# noteの旧ユーザーIDを含む記事URLの復旧に関する調査メモ

- 調査日：2026年11月18日
- 対象：noteのユーザーID（`urlname`）変更前に共有された記事URL
- 目的：Webブラウザで404になる旧記事URLを、UserScriptで現在の記事URLへ自動修復できるか検討する
- 調査方法：利用者によるブラウザ／noteアプリでの動作確認、SingleFileで保存した404ページのHTML解析、先行公開情報の参照

## 結論

**実現可能と考えられる。** 今回の事例では、旧ユーザーIDを含む記事URLは通常のWebブラウザで404になる一方、noteアプリでは記事を開けた。また、記事キーだけを含む `https://note.com/notes/{記事キー}` というURL形式で、現行記事に到達できることが利用者の操作で確認された。

さらに、保存した**404ページのHTML内に現在の正しい記事URLがJSON-LDとして含まれていた**。したがって、次のような処理が有力である。

1. UserScriptをnoteの記事URLで実行する。
2. ページ上の404表示を検出する。
3. 404ページのJSON-LDに現在の記事URLがあれば、それを検証して移動する。
4. 取得できない場合は `/notes/{記事キー}` に移動してnote側の解決処理に任せる。

ただし、確認されたのは主に**1件の記事と1件の保存HTML**であり、noteの全記事、全404ページ、今後の仕様に対する動作保証はない。

## 1. 検証に使用した記事

| 項目 | 値 |
| --- | --- |
| 旧ユーザーID | `daizu_lab` |
| 現在のユーザーID | `appgrove` |
| 記事キー | `n7f3158c18cb9` |
| 旧URL | `https://note.com/daizu_lab/n/n7f3158c18cb9?sub_rt=share_pb` |
| 現在のURL | `https://note.com/appgrove/n/n7f3158c18cb9` |
| IDに依存しない記事URL | `https://note.com/notes/n7f3158c18cb9` |

記事キーの `n7f3158c18cb9` はユーザーID変更前後で共通している。

## 2. 実際に確認された挙動

| 操作・環境 | 結果 | 根拠・確実性 |
| --- | --- | --- |
| Discordから旧URLをnoteアプリで開く | 記事を表示できた | 利用者による画面録画およびアプリで開いたとの申告 |
| 通常のWebブラウザで旧URLを開く | noteの404ページが表示された | 利用者による確認、SingleFile保存HTML |
| `/notes/n7f3158c18cb9` を開く | 記事に到達できた | 利用者が「機能しました」と確認 |
| `/notes/{記事キー}` の転送ステータス | **未確認** | 301であるとの先行情報はあるが、今回の通信ログではHTTPステータスを取得していない |
| noteアプリ内での旧URL解決方法 | **未確認** | アプリが記事キーで解決している可能性はあるが、内部実装は不明 |

したがって、今回の観察だけでは「Web版noteの旧URLが301リダイレクトされる」とは言えない。むしろ、通常のブラウザでは404になった。

## 3. 404ページのHTML解析結果

対象ファイル：`お探しのページが見つかりません。｜note (2026_11_18 1：53：14).html`

保存元URL：`https://note.com/daizu_lab/n/n7f3158c18cb9?sub_rt=share_pb`

### 3.1 404表示を識別できる要素

保存HTMLで以下を確認した。

| 要素 | 保存HTMLでの値 | 404検出への利用 |
| --- | --- | --- |
| `document.title` | `お探しのページが見つかりません。｜note` | 利用できるが、文言変更に依存 |
| `h1` のテキスト | `お探しのページが見つかりません。` | 有力。CSSクラス名に依存しない |
| `meta[name="robots"]` | `noindex` | 404固有ではないため単独で使わない |
| ページ本文 | `あなたがアクセスしたページは削除されたか URLが変更されているため表示することができません。` | 補助的な判定材料 |
| HTTP応答ステータス | 不明 | SingleFileのHTML保存からは元の応答コードを断定できない |

基本的な404判定例：

```javascript
const is404 = [...document.querySelectorAll('h1')].some(
  el => el.textContent?.trim() === 'お探しのページが見つかりません。'
);
```

注：`document-start` の時点では `h1` がまだ存在しない可能性がある。実際のUserScriptではDOM構築後に判定するか、必要に応じて描画完了を待つ。

### 3.2 404ページのJSON-LDに現行URLが含まれていた

保存HTMLに次の構造が存在した（関連部分のみ抜粋）。

```html
<script type="application/ld+json" id="json-ld">
{
  "@context": "http://schema.org",
  "@graph": [
    {
      "@type": "BlogPosting",
      "mainEntityOfPage": "https://note.com/appgrove/n/n7f3158c18cb9"
    }
  ]
}
</script>
```

`@graph` 内には `BreadcrumbList` もあり、現在の `appgrove` のURLを参照していた。つまり、**404画面でも記事メタデータの一部は残っている**。

一方、保存HTMLの以下の項目は**旧URL**を指していた。

- `<link rel="canonical">`
- `<meta property="og:url">`
- `<meta name="twitter:url">`

よって、この事例では `canonical` や `og:url` を現行URLの取得元として使用すべきではない。

### 3.3 JSON-LDの抽出例

```javascript
function findCurrentArticleUrl(articleKey) {
  const script = document.querySelector('script#json-ld[type="application/ld+json"]');
  if (!script) return null;

  try {
    const json = JSON.parse(script.textContent);
    const posting = json['@graph']?.find(item => item['@type'] === 'BlogPosting');
    if (typeof posting?.mainEntityOfPage !== 'string') return null;

    const url = new URL(posting.mainEntityOfPage);
    if (url.origin !== 'https://note.com') return null;
    if (!url.pathname.endsWith(`/n/${articleKey}`)) return null;
    return url;
  } catch {
    return null;
  }
}
```

これは保存したHTMLに基づく抽出例であり、すべての404ページでの互換性は未検証。

## 4. `/notes/{記事キー}` 形式の発見

調査中に、以下の形式が記事キーから記事の所在を解決できるとの先行情報が見つかった。

```text
https://note.com/notes/{記事キー}
```

今回の記事での例：

```text
https://note.com/notes/n7f3158c18cb9
```

利用者がブラウザでこのURLを試し、**機能したことを確認**した。これが、非公式APIを使わずに旧URLを復旧するもっとも重要な発見である。

先行情報にはHTTP **301** リダイレクトとの記載があったが、今回の調査ではネットワークログによるステータス確認はしていない。利用者が検証したのは、リンク先の記事に到達できるという点である。

## 5. 非公式APIを利用する代替方式

先行する非公式の解析記事によると、以下のエンドポイントで記事情報を取得できる。

```text
GET https://note.com/api/v3/notes/{記事キー}
```

レスポンスの `data.user.urlname`（現在のユーザーID）や `data.note_url`（記事URL）を用いてリダイレクト先を組み立てる案がある。

ただし、これは**開発者向けに公開・保証された公式APIではない**。また、今回の会話ではこの具体的な記事キーについてAPIレスポンスを直接検証できていない。`/notes/{記事キー}` またはHTML内のJSON-LDで解決できるなら、API方式は優先度が低い。

## 6. UserScriptの推奨設計

### 検出と処理の順序

```text
note.com/{ユーザーID}/n/{記事キー} を開く
        │
        ▼
DOM構築後に404表示を確認
        │
        ├─ 404ではない ──> 何もしない
        │
        └─ 404である
              │
              ▼
        JSON-LDのBlogPostingを確認
              │
              ├─ URLがあり、同じ記事キーかつnote.com内
              │       └─> 現行URLへ移動
              │
              └─ 取得・検証できない
                      └─> /notes/{記事キー} へ移動
```

**重要な点**：正常ページでの余計な転送を避けるため、単純にすべてのnote記事URLを `/notes/{記事キー}` に書き換えるのではなく、404検出後のみに動作させる。

### UserScriptのサンプル（検証用）

```javascript
// ==UserScript==
// @name         note Old Article URL Recovery
// @namespace    https://note.com/
// @version      0.1.0
// @description  旧note IDで404となる記事URLを復旧
// @match        https://note.com/*/n/n*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const match = location.pathname.match(/^\/([\w-]+)\/n\/(n[0-9a-f]{12})\/?$/i);
  if (!match) return;

  const articleKey = match[2];
  const is404 = [...document.querySelectorAll('h1')].some(
    el => el.textContent?.trim() === 'お探しのページが見つかりません。'
  );
  if (!is404) return;

  let target = null;
  const script = document.querySelector('script#json-ld[type="application/ld+json"]');

  if (script) {
    try {
      const json = JSON.parse(script.textContent);
      const entry = json['@graph']?.find(x => x['@type'] === 'BlogPosting');
      if (typeof entry?.mainEntityOfPage === 'string') {
        const candidate = new URL(entry.mainEntityOfPage);
        if (
          candidate.origin === location.origin &&
          candidate.pathname === `/${candidate.pathname.split('/')[1]}/n/${articleKey}` &&
          candidate.pathname !== location.pathname
        ) {
          target = candidate;
        }
      }
    } catch (error) {
      console.warn('[note URL Recovery] Invalid JSON-LD', error);
    }
  }

  if (!target) {
    target = new URL(`/notes/${articleKey}`, location.origin);
  }

  target.search = location.search;
  target.hash = location.hash;
  location.replace(target.href);
})();
```

このコードは**提案段階の試作であり、全条件での実動作は未検証**。特に、クライアントサイド画面遷移で404要素が後から出現する場合は、`document-idle` の一回だけの検査では見逃す可能性がある。必要なら `MutationObserver` またはURL変更の監視を検討する。

### 安全性・実装上の留意事項

- 対象ドメインを `note.com` に限定する。
- 元URLから抽出した記事キーと、JSON-LD内URLの記事キーが一致することを確かめる。
- 異なるサイトへの転送を禁止する。
- 現在のURLと同じ場合は転送せず、ループを防ぐ。
- クエリ文字列・ハッシュを保持するかどうかは用途に応じて決める（例：`sub_rt=share_pb`）。
- 本当に削除された記事でも404になるので、`/notes/{記事キー}` に移動した結果404になる場合がある。これは必ずしも旧ID問題を意味しない。
- SingleFileは保存時にHTMLを加工するため、**ライブDOMでの再検証**が望ましい。

## 7. 未解決・追加確認が必要な点

1. **404判定の汎用性**：削除済み・非公開・存在しない記事キーでも同じ `h1` とJSON-LDになるか。
2. **HTTPステータス**：旧URLと `/notes/{記事キー}` で実際に何番のステータスが返るか（DevToolsのNetworkで確認）。
3. **DOMのタイミング**：通常ロードとSPA遷移で、404見出しとJSON-LDがいつ挿入されるか。
4. **仕様の安定性**：`/notes/{記事キー}` とJSON-LDの形式が将来も維持されるか。
5. **対象の範囲**：記事以外のURLや、ID変更以外の理由で404となったページはどう扱うか。
6. **既存ツール**：Greasy Fork・GitHub・拡張機能ストアの調査では同目的の既存実装を確認できなかったが、存在しないと断定はできない。

## 8. 参考情報

以下はこの会話中に参照された第三者資料であり、今回のHTML解析とは別の情報源である。

- [noteAPIについて（GitHub Wiki）](https://github.com/Tom-atok/note_analysis/wiki/noteAPI%E3%81%AB%E3%81%A4%E3%81%84%E3%81%A6)：非公式APIの解説
- [2024年版 note API 非公式一覧表](https://note.egg-glass.jp/%E3%83%97%E3%83%AD%E3%82%B0%E3%83%A9%E3%83%9F%E3%83%B3%E3%82%B0/2024/06/28/noteAPI.html)：APIエンドポイントの整理
- [note非公式API、249記事で検証した13フィールド](https://note.com/note_id1951/n/n5b233dd64383)：記事APIのレスポンスに含まれるフィールドについての報告
- [検証に用いた旧URL](https://note.com/daizu_lab/n/n7f3158c18cb9?sub_rt=share_pb)
- [確認できたID非依存URL](https://note.com/notes/n7f3158c18cb9)

---

### 確度の整理

- **確認済み**：Webブラウザで旧URLが404となる／noteアプリでは開けた／`/notes/{記事キー}` で記事に到達できた／保存404 HTMLの `h1` とJSON-LDの内容。
- **推測または先行資料に基づく**：noteアプリが記事キーで解決しているという内部処理／`/notes/{記事キー}` のHTTP 301という具体的なステータス／非公式APIの現在の詳細仕様。
- **未検証**：多数の記事・異なる404原因・将来の変更・提案UserScriptのクロスブラウザでの動作。

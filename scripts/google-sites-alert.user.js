// ==UserScript==
// @name         Google Sites Alert
// @namespace    net.appgrove.userscripts
// @version      1.0.1
// @description  Google Sitesを開いた時に、Google公式でないことを警告する
// @author       appgrove
// @license      Apache-2.0
// @homepageURL  https://github.com/App-Grove/AppGrove-s-UserScripts
// @supportURL   https://github.com/App-Grove/AppGrove-s-UserScripts/issues
// @match        https://sites.google.com/view/*
// @run-at       document-start
// @grant        none
// @updateURL   https://raw.githubusercontent.com/App-Grove/AppGrove-s-UserScripts/main/scripts/google-sites-alert.user.js
// ==/UserScript==

(function () {
  "use strict";
  // CSS
  const style = document.createElement("style");
  style.textContent = `
      dialog {
          padding: 24px;
          border: none;
          border-radius: 12px;
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
          width: min(90vw, 400px);
      }
      dialog::backdrop {
          background: rgba(0, 0, 0, 0.5);
      }
      dialog h2 {
          margin-top: 0;
      }
      dialog p {
          line-height: 1.6;
      }
      .buttons {
          display: flex;
          justify-content: center;
          gap: 8px;
          margin-top: 20px;
      }
      button {
          padding: 8px 16px;
          border-radius: 6px;
          cursor: pointer;
          color: white;
      }
      button[value="back"] {
          background-color: #5cb85c;
          border: none;
      }
      button[value="forward"] {
          background-color: #d9534f;
          border: none;
      }
  `;

  (document.head || document.documentElement).appendChild(style);

  function showDialog() {
      // ダイアログを作成
      const dialog = document.createElement("dialog");

      dialog.innerHTML = `
          <form method="dialog">
              <h2>⚠️ 警告</h2>
              <p>
                  このページのコンテンツはユーザーによって作成されました。<br>
                  Google公式ではないため、アカウント情報を入力しないようご注意ください。<br>
                  <br>
                  続行しますか？
              </p>
              <div class="buttons">
                  <button value="forward" type="submit">警告を理解して進む</button>
                  <button value="back" type="button">元のページに戻る</button>
              </div>
          </form>
      `;
      document.body.appendChild(dialog);

      dialog.querySelector('[value="back"]').addEventListener("click", () => {
          dialog.close();
          history.back();
      });

      dialog.showModal();
  }

  if (document.body) {
      showDialog();
  } else {
      document.addEventListener("DOMContentLoaded", showDialog, { once: true });
  }
})();

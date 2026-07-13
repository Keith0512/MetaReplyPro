# 「顯示機器人」開關設計

日期：2026-07-14
狀態：已與使用者確認

## 問題

內容腳本注入的右下角「🤖 自動回覆」浮動按鈕有時會擋住 Meta 商務套件的頁面元素，
使用者需要一個開關可以暫時隱藏它。

## 設計

- **儲存**：`chrome.storage.sync` 新增獨立鍵 `showFloatingButton`（boolean，未設定視為 `true`）。
  用獨立鍵而非塞進 `settings` 物件，避免 popup 與設定頁互相覆蓋。
- **popup**（popup.html＋新增 popup.js，MV3 不允許內嵌 script）：
  「開啟控制面板」按鈕上方新增「顯示機器人」切換開關；載入時讀取現值，切換即寫入 storage。
- **content.js**：照常注入浮動按鈕，依 `showFloatingButton` 以 `display:none` 隱藏
  （不採「關閉時不注入」，避免重新注入邏輯）；`storage.onChanged` 監聽變更即時套用，
  不需重新整理頁面。
- 狀態經 Chrome 帳號同步，所有 FB/IG 頁面一致。

## 驗收

1. popup 開關預設為開；關閉後所有頁面的浮動按鈕立即消失（含已開啟的分頁）。
2. 重新整理、重開瀏覽器後狀態維持。
3. 再打開開關，按鈕立即恢復。

# 貼文商品綁定修正

舊版以標題前 20 字讀取、覆寫及刪除綁定，會讓不同貼文共用商品。

新版在 Meta Business Suite 的 `/latest/inbox/facebook`、`/latest/inbox/instagram`
（以及不含 `/latest` 的同類路徑）使用 URL 中的 `asset_id` 與
`selected_item_id`，保存為 `v2:<平台>:<粉專／資產 ID>:<貼文 ID>`。
只精確查找或刪除完整 key，不使用標題、標題前綴或整段 URL。
缺少 ID、重複參數、未知路徑時不儲存或自動套用綁定，仍可手動選商品執行。

原本 `postProductMapping` 的舊資料保留，設定頁會標示為舊版紀錄。
因為舊標題沒有粉專與貼文身分，不能安全自動遷移（完整標題相同也不代表同一篇）。
使用者須到原貼文核對後重新綁定；舊紀錄仍可匯出、匯入或個別刪除。
已被舊版覆寫的綁定無法由剩餘資料復原。

執行 `npm run test:bindings` 可驗證識別、資料相容、選取與模擬 FB／IG 私訊流程。
測試不登入 Meta、不發送真實訊息。真實頁面的 URL 與 DOM 仍需人工驗收：
確認目前頁面提供的 `selected_item_id` 對應選中貼文，切換貼文及粉專後
ID 隨之改變；不提供完整 ID 的頁面應提示手動選擇。

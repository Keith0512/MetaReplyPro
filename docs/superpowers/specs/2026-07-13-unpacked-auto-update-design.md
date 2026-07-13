# MetaReplyPro 未封裝擴充功能自動更新機制 — 設計文件

日期：2026-07-13
狀態：已由使用者核准

## 背景與目標

MetaReplyPro 是一個 Chrome MV3 擴充功能（`chrome-extension/`），目前只能以「載入未封裝項目」方式安裝，供少數同事朋友使用。Chrome 不會自動更新未封裝的擴充功能，因此需要自製更新機制，讓開發者 push 新版到 GitHub 後，所有使用者的電腦能自動取得並套用最新版。

已評估並排除的替代方案：

- **Chrome Web Store（未上市）**：使用者選擇不走上架流程。
- **自行託管 CRX**：Windows 家用版無企業政策環境，不可行。

前提條件：GitHub repo `Keith0512/MetaReplyPro` 將由使用者**親自改為 Public**（Settings → Danger Zone → Change visibility），更新腳本因此不需任何憑證。已確認版控內容無金鑰（Gemini 金鑰在 `.env.local`，未進版控）。

## 整體流向

```
開發者：改程式 → manifest.json version +1 → push 到 main
         ↓
使用者電腦：Windows 排程執行 update.ps1 → 發現新版 → 下載 main.zip → 覆蓋本機 chrome-extension/
         ↓
擴充功能：background.js 定時比對「磁碟上的版號」與「執行中的版號」→ 不一致 → chrome.runtime.reload()
```

main 分支即正式發佈通道：push 到 main 等於發佈給所有使用者。

## 部件一：PowerShell 更新腳本（不需安裝 Git）

### update.ps1

1. 抓 `https://raw.githubusercontent.com/Keith0512/MetaReplyPro/main/chrome-extension/manifest.json`，取遠端 `version`。
2. 與本機安裝目錄的 `manifest.json` 版號比對；**相同即結束**（不下載）。
3. 有新版：下載 `https://github.com/Keith0512/MetaReplyPro/archive/refs/heads/main.zip` 到暫存目錄並解壓。
4. 把現有 `chrome-extension/` 改名保留為 `chrome-extension.backup`（僅保留最近一版），再把新版檔案放入定位。
5. 任一步驟失敗（網路、解壓、檔案操作）→ 保留原版本不動，還原備份，寫入 `update.log`。
6. 所有動作附時間戳記寫入 `update.log`。

### setup.ps1（給朋友的一鍵初始安裝）

1. 建立安裝目錄 `%LOCALAPPDATA%\MetaReplyPro`。
2. 下載最新 main.zip，解出 `chrome-extension/` 與更新腳本。
3. 建立 Windows 排程工作「MetaReplyPro Update」：每次使用者登入時＋每天 12:00 各執行一次 `update.ps1`。
4. 完成後顯示指引：開啟 `chrome://extensions` → 開發人員模式 → 載入未封裝項目 → 選 `%LOCALAPPDATA%\MetaReplyPro\chrome-extension`（僅首次需要）。

## 部件二：擴充功能內建自動重載

- `manifest.json`：`permissions` 加入 `"alarms"`。
- `background.js`：新增約 20 行——

  1. `chrome.runtime.onInstalled` / `onStartup` 時建立 `chrome.alarms.create('update-check', { periodInMinutes: 5 })`。
  2. alarm 觸發時 `fetch(chrome.runtime.getURL('manifest.json'))` 讀取**磁碟上**的版號（未封裝擴充功能的資源即時從磁碟讀取）。
  3. 與 `chrome.runtime.getManifest().version`（記憶體中執行的版本）比對；不一致 → `chrome.runtime.reload()`。
  4. 版本相同時不動作；reload 後兩者一致，不會無限重載。純本機檢查、零網路流量。

## 錯誤處理彙總

| 情境 | 行為 |
|------|------|
| 下載/解壓失敗 | 保留原版，寫 log，下次排程再試 |
| 覆蓋中途失敗 | 從 `chrome-extension.backup` 還原 |
| 磁碟 manifest 讀取失敗（更新腳本正在覆蓋中） | 本次略過，5 分鐘後下次 alarm 再檢查 |
| 推壞版本到 main | 屬流程風險：開發者 push 前需自測；可再 push 修正版讓機制自動復原 |

## 發佈流程（開發者端）

1. 改完程式，`chrome-extension/manifest.json` 的 `version` 加號（例 `1.0.0` → `1.0.1`）。
2. push 到 `main`。
3. 使用者電腦於下次排程（登入或每天 12:00）自動更新，5 分鐘內擴充功能自動重載。

## 修訂（2026-07-13）：私有 repo ＋ 手動開放的發佈流程

使用者決定 repo 平常保持**私有**，發佈時才暫時開放，並以手動觸發為主要更新方式：

- **setup.ps1** 加建桌面捷徑「MetaReplyPro 更新」（以 `-Interactive` 執行 update.ps1），作為同事的一鍵更新按鈕；排程保留為備援（repo 私有時安靜失敗）。
- **update.ps1** 新增 `-Interactive` 開關：顯示進度與結果、結束前暫停。
- **設定頁**新增「🔄 版本與更新」卡片：顯示目前版本＋「檢查更新」按鈕（僅偵測與提示——Chrome 擴充功能無法執行本機程式，實際更新靠桌面捷徑）。manifest 加 `https://raw.githubusercontent.com/*` host 權限。
- **發佈流程**改為：version +1 → push main → repo 改 Public → 通知同事點捷徑 → 全員更新完改回 Private。
- **install.ps1**（同日修復）：`irm | iex` 的引導安裝器，純 ASCII 無 BOM；因 setup.ps1 的 UTF-8 BOM 會讓 iex 解析失敗（param 不被視為首語句），且 iex 下 exit 會關閉使用者視窗，故以原始 bytes 下載後改用 `-File` 執行。

## 測試計畫

1. **版號比對邏輯**：update.ps1 在「遠端=本機」時不下載、「遠端較新」時下載覆蓋。
2. **端對端**：本機安裝 → 推一個 version+1 的 commit → 執行 update.ps1 → 確認檔案更新 → 確認擴充功能在 5 分鐘內自動 reload（可暫時把 alarm 調短觀察）。
3. **失敗還原**：模擬下載失敗（斷網/錯誤 URL），確認原版完好、log 有紀錄。

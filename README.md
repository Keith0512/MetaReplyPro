<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/a7bce6a4-5304-40f9-8e0d-f45e166ebb37

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Chrome 擴充功能：安裝與自動更新

### 首次安裝（Windows）

> 安裝的當下 repo 必須處於「公開」狀態（請先聯絡管理員開放）。

開啟 PowerShell，貼上執行：

```powershell
irm https://raw.githubusercontent.com/Keith0512/MetaReplyPro/main/updater/install.ps1 | iex
```

完成後依畫面指示到 `chrome://extensions` 開啟「開發人員模式」，
用「載入未封裝項目」選擇 `%LOCALAPPDATA%\MetaReplyPro\chrome-extension`（只有第一次需要）。

> 💡 這個資料夾在隱藏的 AppData 裡，用滑鼠瀏覽找不到。安裝腳本已把路徑複製到剪貼簿，
> 在「載入未封裝項目」跳出的視窗下方「資料夾」欄位按 Ctrl+V 貼上、再按「選擇資料夾」即可。
> 想在檔案總管看到隱藏資料夾：檔案總管 → 檢視 → 顯示 → 勾選「隱藏的項目」。

### 更新機制

- Repo 平常保持私有，開發者發佈新版時暫時開放。
- **一鍵更新（主要方式）**：設定頁「🔄 版本與更新」卡片按「立即更新」，透過安裝時註冊的 Native Messaging 橋接程式執行更新並自動重新載入；「檢查更新」可先確認是否有新版。
- **桌面捷徑（備用）**：點兩下桌面的「MetaReplyPro 更新」捷徑，會顯示檢查與更新結果。
- 排程備援：Windows 排程工作「MetaReplyPro Update」在登入時與每天 12:00 自動檢查；repo 未開放時會安靜跳過。
- 更新紀錄在 `%LOCALAPPDATA%\MetaReplyPro\update.log`；上一版備份在 `chrome-extension.backup`。

### 發佈新版（開發者）

1. 修改程式後，把 `chrome-extension/manifest.json` 的 `version` 加一號（例如 `1.2.0` → `1.2.1`），push 到 `main`。
2. 到 GitHub 把 repo 改為 **Public**（Settings → Danger Zone → Change visibility）。
3. 通知同事在設定頁按「立即更新」（或點桌面捷徑；都沒動的人也會在登入或中午的排程自動補更新）。
4. 確認大家都更新完後，把 repo 改回 **Private**。

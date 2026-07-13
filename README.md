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

開啟 PowerShell，貼上執行：

```powershell
irm https://raw.githubusercontent.com/Keith0512/MetaReplyPro/main/updater/setup.ps1 | iex
```

完成後依畫面指示到 `chrome://extensions` 開啟「開發人員模式」，
用「載入未封裝項目」選擇 `%LOCALAPPDATA%\MetaReplyPro\chrome-extension`（只有第一次需要）。

### 自動更新機制

- 安裝時會建立 Windows 排程工作「MetaReplyPro Update」：登入時與每天 12:00 檢查 GitHub 上的新版本，有新版才下載覆蓋。
- 擴充功能每 5 分鐘比對磁碟上的版本，發現已更新就自動重新載入，使用者不需任何操作。
- 更新紀錄寫在 `%LOCALAPPDATA%\MetaReplyPro\update.log`；上一版備份在 `chrome-extension.backup`。

### 發佈新版（開發者）

1. 修改程式後，把 `chrome-extension/manifest.json` 的 `version` 加一號（例如 `1.1.0` → `1.1.1`）。
2. push 到 `main`。main 分支即正式發佈通道，所有使用者會在下次排程時自動更新。

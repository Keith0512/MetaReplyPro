# MetaReplyPro

MetaReplyPro 是提供 Facebook／Instagram 商務留言回覆功能的 Chrome 擴充功能。

## 本機開發

需求：Node.js。

```bash
npm install
npm run dev
```

需要使用 AI Studio 功能時，請依照 `.env.example` 建立 `.env.local`，不要把 API key 加入 Git。

## Windows 安裝

### 重要安全規則

- 不要再執行 `irm .../main/... | iex`。
- 不要直接下載或安裝 `main.zip`。
- 初次安裝必須使用管理員已驗證並透過可信管道提供的正式 release ZIP。
- 更新器只接受固定公開金鑰簽署的 release manifest；ZIP 的 SHA-256、版本及 commit 任一不符都會拒絕更新。

### 首次安裝

1. 向管理員取得已驗證的 `MetaReplyPro-vX.Y.Z.zip`。
2. 解壓縮 ZIP。
3. 在解壓後的資料夾執行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\updater\install.ps1
```

4. 到 `chrome://extensions` 開啟「開發人員模式」，選擇安裝程式顯示並複製到剪貼簿的 `chrome-extension` 資料夾。

安裝器預設不建立自動排程。設定頁的「立即更新」及桌面「MetaReplyPro 更新」捷徑都會先驗證簽章。

### 舊版緊急緩解

已使用舊安裝器的電腦，請先停用原本的自動更新排程：

```powershell
Disable-ScheduledTask -TaskName 'MetaReplyPro Update'
```

接著使用可信管道取得的正式 release ZIP 重新安裝一次，建立新的更新信任根。不要用舊版「立即更新」按鈕進行這次遷移。

### 選擇性啟用排程

完成安全版本安裝及 Windows 負向測試後，才可從解壓後的正式 release 明確啟用排程：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\updater\setup.ps1 -SourceDir . -EnableScheduledTask
```

排程會在登入及每日 12:00 執行，但每次仍必須通過簽章與 SHA-256 驗證。

## 正式發布

### 簽章金鑰

- `updater/trusted-update-key.json` 是可公開的信任根，必須進版控。
- RSA 私鑰不得放入 repository、release ZIP、雲端同步資料夾或聊天訊息。
- 私鑰應由指定發布人保管，限制檔案權限並保存一份離線加密備份。
- 遺失私鑰時，現有客戶端不會信任新金鑰；金鑰輪替必須先用舊金鑰簽署過渡版本。

建立全新金鑰只應執行一次：

```bash
node updater/release/generate-signing-key.mjs \
  --private-key /absolute/path/outside-repository/release-signing-private.pem
```

### 建置 release

1. 完成程式碼審查。
2. 更新 `chrome-extension/manifest.json` 版本並提交。
3. 確認工作目錄乾淨，而且目前 commit 就是要發布的內容。
4. 用保管的私鑰建置：

```bash
node updater/release/build-release.mjs \
  --private-key /absolute/path/to/release-signing-private.pem
```

輸出位置為 `release/vX.Y.Z/`，包含：

- `MetaReplyPro-vX.Y.Z.zip`
- `update-manifest.json`
- `update-manifest.json.sig`

發布前再驗證一次：

```bash
node updater/release/verify-release.mjs \
  --manifest release/vX.Y.Z/update-manifest.json
```

建立與版本相同的 GitHub tag／release，並原樣上傳這三個檔案。不要重新壓縮或手動修改 manifest；任何 byte 改變都會讓簽章或 SHA-256 失效。

更新器固定從 GitHub Releases 的 `latest/download` 讀取已簽章 manifest，再依 manifest 下載版本化 asset，不再信任浮動 `main`。Repository 無法匿名讀取時，客戶端只會記錄失敗並保留舊版。

## 測試

跨平台 release 簽章與竄改測試：

```bash
npm run test:release
```

Windows PowerShell 5.1 完整測試：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\updater\tests\run-tests.ps1
```

Windows 測試涵蓋正常更新、錯誤簽章、SHA-256 不符、版本／commit 不一致、安裝來源驗證與 Native Messaging。

# MetaReplyPro

MetaReplyPro 是提供 Facebook／Instagram 商務留言回覆功能的 Chrome 擴充功能。

從 1.5.1 起，擴充功能設定頁的「立即更新」同時支援 Windows 與 macOS。兩個系統都會先驗證正式 Release 的簽章、commit、版本及 ZIP 的 SHA-256，驗證失敗就保留舊版。

從 1.5.3 起，按「檢查更新內容」或「立即更新」會先顯示 GitHub 最新正式版本的更新說明；閱讀後按「確認更新」才會啟動安全更新器。1.5.2 的舊介面尚無預覽，升級至 1.5.3 前可先閱讀 GitHub Release 頁的說明。

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

## macOS 安裝

需求：Google Chrome。不需要安裝 Node、Python、Homebrew，也不需要管理員權限。

1. 向管理員取得已驗證的 `MetaReplyPro-vX.Y.Z.zip`。
2. 解壓縮 ZIP。
3. 開啟「終端機」，進入解壓後的資料夾並執行：

```bash
/bin/zsh ./updater/install-macos.sh
```

4. 安裝完成後，到 `chrome://extensions` 開啟「開發人員模式」。
5. 點「載入未封裝項目」，貼上安裝器已複製到剪貼簿的資料夾路徑。

安裝器會把程式放在：

```text
~/Library/Application Support/MetaReplyPro
```

並在 Chrome 規定的使用者目錄註冊 Native Messaging host。完成這次安裝後，日後可直接在擴充功能設定頁按「立即更新」，操作方式與 Windows 相同。

已手動載入 1.5.0 或更早版本的 Mac，必須先用 1.5.1（或更新版本）的正式 ZIP 執行上述安裝一次，才能建立 macOS 的 Native Messaging host。這次遷移不會刪除商品資料、對話範本或設定，因為這些資料保存在相同擴充功能 ID 的 Chrome Storage。

macOS 更新紀錄位於：

```text
~/Library/Application Support/MetaReplyPro/update.log
```

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

- `updater/trusted-update-key.json` 與 `updater/trusted-update-key.pem` 是同一把可公開信任根的 Windows／macOS 格式，必須一起進版控。
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

macOS 完整測試：

```bash
npm run test:macos
```

macOS 測試涵蓋本機安裝、Chrome host 註冊、正常更新、錯誤簽章、SHA-256 不符、版本／commit 不一致、備份保留與 Native Messaging stdio 協議。

# MetaReplyPro 簽章 Release 更新設計

日期：2026-07-25
狀態：已實作（Windows 1.5.0；macOS 1.5.1）

## 安全目標

GitHub repository、`main` 分支或傳輸中的 release asset 即使遭到未授權修改，已安裝的 MetaReplyPro 也不得套用未由指定發布私鑰簽署的內容。

## 信任根

- 發布端使用獨立 RSA 3072-bit 私鑰，以 RSASSA-PKCS1-v1_5／SHA-256 簽署 manifest 的原始 UTF-8 bytes。
- Windows 客戶端保存 `trusted-update-key.json`，macOS 客戶端保存相同公開金鑰的 JSON 與 PEM 格式。
- 私鑰不進 Git，由發布保管人限制權限並離線備份。
- 更新包內的公開金鑰必須與目前信任根相同，避免意外或未規劃的金鑰輪替。

## Release 格式

`update-manifest.json` 包含：

- schema 版本
- 簽章金鑰 ID
- 擴充功能版本
- 40 字元 commit SHA
- 固定版本 asset 名稱與 GitHub Release URL
- asset SHA-256
- 發布時間

`update-manifest.json.sig` 是 manifest 原始 bytes 的 Base64 RSA-SHA256 簽章。

ZIP 只有一個頂層資料夾，並包含：

- `chrome-extension/`
- 安全更新器與 Native Messaging host
- `trusted-update-key.json`
- `trusted-update-key.pem`
- `release-info.json`，記錄版本與 commit

## 客戶端驗證順序

1. 只從 `https://github.com/Keith0512/MetaReplyPro/releases/...` 下載 manifest 與簽章。
2. 在解析 manifest 或採信任何欄位前驗證 RSA-SHA256 簽章。
3. 拒絕不支援的 schema、錯誤 key ID、非 HTTPS／非指定 repository URL、無效版本、commit 或 SHA-256。
4. 只有遠端版本高於本機時下載 asset。
5. 下載後比對完整 ZIP 的 SHA-256，再解壓縮。
6. 核對 ZIP 內版本、commit、必要更新檔及公開金鑰。
7. 備份舊擴充功能與更新器後換版；換版失敗時還原。

## macOS Native Messaging

- 使用者安裝位置為 `~/Library/Application Support/MetaReplyPro`，不需要管理員權限。
- Chrome host manifest 位於 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.metareplypro.updater.json`。
- manifest 以絕對路徑指向 `native-host-macos.sh`，且 `allowed_origins` 只允許固定的 MetaReplyPro 擴充功能 ID。
- host 遵循 Chrome Native Messaging 的 4-byte native-endian 長度加 UTF-8 JSON stdio 協議；stdout 不輸出其他內容。
- macOS 更新器只使用系統內建的 zsh、curl、OpenSSL、shasum、plutil 與 unzip，不要求 Node、Python 或 Homebrew。
- 1.5.0 或更早的 Mac 安裝必須先以 1.5.1 正式 ZIP 手動安裝一次，建立原生 host 後才能使用設定頁的「立即更新」。

## 安裝與排程

- 初次安裝不再從 `raw/main` 下載或執行 PowerShell。
- 安裝來源必須是已驗證並解壓後的正式 release。
- 排程預設停用；只有明確指定 `-EnableScheduledTask` 才建立。
- 重新安裝安全版本時，預設會停用舊的 `MetaReplyPro Update` 排程。
- 舊客戶端必須透過可信管道手動遷移，不能用舊更新鏈建立初始信任根。

## 發布限制

- 正式建置要求乾淨工作目錄，manifest 版本與當前 commit 會寫入簽章資料。
- Builder 會確認私鑰與版控中的公開金鑰相符，並在輸出前自我驗章。
- 正式 ZIP、manifest、signature 必須原樣上傳同一個版本的 GitHub Release。
- GitHub MFA、審查與發布權限限制是必要的縱深防禦，但不能取代客戶端簽章驗證。

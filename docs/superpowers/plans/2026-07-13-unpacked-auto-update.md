# MetaReplyPro 未封裝自動更新機制 Implementation Plan

> **已於 2026-07-25 被安全更新設計取代。** 此計畫中的浮動 `main` 下載與預設排程僅供歷史參考，不得重新實作。請見 `../specs/2026-07-25-signed-release-update-design.md`。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓以「載入未封裝項目」安裝的 MetaReplyPro 擴充功能，在開發者 push 新版到 GitHub main 後，使用者電腦自動下載、覆蓋並重新載入新版。

**Architecture:** 兩個部件——① 使用者電腦上的 PowerShell 更新腳本（Windows 排程觸發，比對 GitHub 上的 manifest 版號，有新版才下載 zip 覆蓋本機檔案，含備份與還原）；② 擴充功能 background.js 以 chrome.alarms 每 5 分鐘比對「磁碟上的 manifest 版號」與「執行中的版號」，不一致即 `chrome.runtime.reload()`。

**Tech Stack:** Windows PowerShell 5.1（Invoke-WebRequest、Expand-Archive、Register-ScheduledTask）、Chrome Extension MV3（alarms API）。

**前提：** GitHub repo `Keith0512/MetaReplyPro` 需由使用者親自改為 Public（實作與本機測試不受影響，但朋友電腦實際更新前必須完成）。

**測試方式說明：** PowerShell 腳本以「本機檔案模擬 GitHub 遠端」的整合測試腳本驗證（update.ps1 的下載函式對非 http 來源改用 Copy-Item，即是為了讓測試能以本機 fixture 取代網路）。擴充功能部分無自動化測試環境，以明確的手動步驟驗證。

**檔案結構：**

```
updater/
  update.ps1           ← 更新腳本（部署到使用者電腦，也留在 repo 內供自我更新）
  setup.ps1            ← 朋友的一鍵初始安裝腳本
  tests/
    test-update.ps1    ← update.ps1 整合測試
    test-setup.ps1     ← setup.ps1 整合測試
chrome-extension/
  manifest.json        ← 加 alarms 權限、版號 1.0.0 → 1.1.0
  background.js        ← 加自動重載檢查（約 25 行）
README.md              ← 加「安裝與自動更新」章節
```

使用者電腦上的安裝配置（由 setup.ps1 建立）：

```
%LOCALAPPDATA%\MetaReplyPro\
  chrome-extension\           ← Chrome 載入未封裝項目指向這裡
  chrome-extension.backup\    ← 上一版備份（更新時自動產生）
  update.ps1
  update.log
```

---

### Task 1: update.ps1 — 版本比對、下載覆蓋、備份還原、log

**Files:**
- Create: `updater/update.ps1`
- Test: `updater/tests/test-update.ps1`

- [ ] **Step 1: 寫整合測試（此時 update.ps1 尚不存在，測試必然失敗）**

建立 `updater/tests/test-update.ps1`：

```powershell
# update.ps1 整合測試：以本機檔案模擬 GitHub 遠端（manifest 網址與 zip 網址都給本機路徑）
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ("MetaReplyProTest_" + [guid]::NewGuid().ToString('N'))
$script:failed = $false

function Assert($condition, $name) {
  if ($condition) { Write-Host "PASS  $name" }
  else { Write-Host "FAIL  $name" -ForegroundColor Red; $script:failed = $true }
}

$updateScript = Join-Path $PSScriptRoot '..\update.ps1'

# --- 假的本機安裝目錄（版本 1.0.0）
$installDir = Join-Path $root 'install'
New-Item -ItemType Directory -Path (Join-Path $installDir 'chrome-extension') -Force | Out-Null
'{ "version": "1.0.0", "name": "test" }' | Set-Content (Join-Path $installDir 'chrome-extension\manifest.json') -Encoding utf8
'old' | Set-Content (Join-Path $installDir 'chrome-extension\content.js') -Encoding utf8

# --- 假的「遠端」：版本 1.1.0，zip 模擬 GitHub 下載包（內含 MetaReplyPro-main\ 根目錄）
$remoteDir = Join-Path $root 'remote'
$repoDir = Join-Path $remoteDir 'MetaReplyPro-main'
New-Item -ItemType Directory -Path (Join-Path $repoDir 'chrome-extension') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $repoDir 'updater') -Force | Out-Null
'{ "version": "1.1.0", "name": "test" }' | Set-Content (Join-Path $repoDir 'chrome-extension\manifest.json') -Encoding utf8
'new' | Set-Content (Join-Path $repoDir 'chrome-extension\content.js') -Encoding utf8
Copy-Item $updateScript (Join-Path $repoDir 'updater\update.ps1')
$zipPath = Join-Path $remoteDir 'main.zip'
Compress-Archive -Path $repoDir -DestinationPath $zipPath
$remoteManifest = Join-Path $repoDir 'chrome-extension\manifest.json'

# --- 測試 1：有新版 → 更新檔案、保留備份
& $updateScript -InstallDir $installDir -ManifestUrl $remoteManifest -ZipUrl $zipPath
$newVersion = (Get-Content (Join-Path $installDir 'chrome-extension\manifest.json') -Raw | ConvertFrom-Json).version
Assert ($newVersion -eq '1.1.0') '有新版時更新 manifest 至 1.1.0'
Assert ((Get-Content (Join-Path $installDir 'chrome-extension\content.js') -Raw).Trim() -eq 'new') '有新版時更新程式檔案'
Assert (Test-Path (Join-Path $installDir 'chrome-extension.backup\manifest.json')) '更新後保留舊版備份'

# --- 測試 2：已是最新版 → 完全不動作（放一個 marker 檔驗證沒被覆蓋）
'marker' | Set-Content (Join-Path $installDir 'chrome-extension\content.js') -Encoding utf8
& $updateScript -InstallDir $installDir -ManifestUrl $remoteManifest -ZipUrl $zipPath
Assert ((Get-Content (Join-Path $installDir 'chrome-extension\content.js') -Raw).Trim() -eq 'marker') '版本相同時不重新下載覆蓋'

# --- 測試 3：遠端讀取失敗 → 本機檔案完好、結束碼非 0
& $updateScript -InstallDir $installDir -ManifestUrl (Join-Path $root 'nonexistent.json') -ZipUrl $zipPath
Assert ($LASTEXITCODE -ne 0) '遠端讀取失敗時結束碼非 0'
Assert (Test-Path (Join-Path $installDir 'chrome-extension\manifest.json')) '遠端讀取失敗時本機檔案完好'

# --- 測試 4：log 檔有寫入
Assert (Test-Path (Join-Path $installDir 'update.log')) '寫入 update.log'

Remove-Item $root -Recurse -Force
if ($script:failed) { Write-Host "`n有測試失敗" -ForegroundColor Red; exit 1 }
else { Write-Host "`n全部通過"; exit 0 }
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File updater\tests\test-update.ps1`
Expected: 錯誤終止（Copy-Item 找不到 `updater\update.ps1`），結束碼非 0。

- [ ] **Step 3: 實作 update.ps1**

建立 `updater/update.ps1`：

```powershell
# MetaReplyPro 自動更新腳本
# 由 Windows 排程工作定時執行：比對 GitHub 上的版本，有新版才下載覆蓋本機 chrome-extension\。
# 擴充功能本身會偵測到磁碟檔案變新並自動重新載入（見 background.js）。
param(
  [string]$InstallDir = "$env:LOCALAPPDATA\MetaReplyPro",
  [string]$ManifestUrl = 'https://raw.githubusercontent.com/Keith0512/MetaReplyPro/main/chrome-extension/manifest.json',
  [string]$ZipUrl = 'https://github.com/Keith0512/MetaReplyPro/archive/refs/heads/main.zip'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $InstallDir)) {
  Write-Host "找不到安裝目錄 $InstallDir，請先執行 setup.ps1"
  exit 1
}

$logFile = Join-Path $InstallDir 'update.log'
function Write-Log([string]$Message) {
  Add-Content -Path $logFile -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $Message) -Encoding utf8
}

# 來源為 http(s) 時下載，否則視為本機路徑複製（供測試以本機 fixture 模擬遠端）
function Get-RemoteFile([string]$Source, [string]$Destination) {
  if ($Source -match '^https?://') {
    Invoke-WebRequest -Uri $Source -OutFile $Destination -UseBasicParsing
  } else {
    Copy-Item -Path $Source -Destination $Destination -Force
  }
}

$extensionDir = Join-Path $InstallDir 'chrome-extension'
$backupDir    = Join-Path $InstallDir 'chrome-extension.backup'
$tempDir      = Join-Path $env:TEMP ("MetaReplyProUpdate_" + [guid]::NewGuid().ToString('N'))

try {
  New-Item -ItemType Directory -Path $tempDir | Out-Null

  $localVersion = [version](Get-Content (Join-Path $extensionDir 'manifest.json') -Raw -Encoding utf8 | ConvertFrom-Json).version

  $remoteManifestPath = Join-Path $tempDir 'manifest.json'
  Get-RemoteFile $ManifestUrl $remoteManifestPath
  $remoteVersion = [version](Get-Content $remoteManifestPath -Raw -Encoding utf8 | ConvertFrom-Json).version

  if ($remoteVersion -le $localVersion) {
    Write-Log "已是最新版 $localVersion（遠端 $remoteVersion），不需更新"
    exit 0
  }

  Write-Log "發現新版 $remoteVersion（本機 $localVersion），開始下載"

  $zipPath = Join-Path $tempDir 'repo.zip'
  Get-RemoteFile $ZipUrl $zipPath
  $extractDir = Join-Path $tempDir 'extracted'
  Expand-Archive -Path $zipPath -DestinationPath $extractDir
  $repoRoot = Get-ChildItem -Directory $extractDir | Select-Object -First 1
  $newExtensionDir = Join-Path $repoRoot.FullName 'chrome-extension'
  if (-not (Test-Path (Join-Path $newExtensionDir 'manifest.json'))) {
    throw '下載內容中找不到 chrome-extension\manifest.json'
  }

  # 備份舊版後換上新版；換版失敗則還原備份
  if (Test-Path $backupDir) { Remove-Item $backupDir -Recurse -Force }
  Move-Item $extensionDir $backupDir
  try {
    Copy-Item $newExtensionDir $extensionDir -Recurse
  } catch {
    if (Test-Path $extensionDir) { Remove-Item $extensionDir -Recurse -Force }
    Move-Item $backupDir $extensionDir
    throw
  }

  # 最後更新腳本自身（PowerShell 執行前已解析完整個檔案，覆寫執行中的腳本是安全的）
  $newUpdater = Join-Path $repoRoot.FullName 'updater\update.ps1'
  if (Test-Path $newUpdater) {
    Copy-Item $newUpdater (Join-Path $InstallDir 'update.ps1') -Force
  }

  Write-Log "更新完成：$localVersion → $remoteVersion"
  exit 0
} catch {
  Write-Log "更新失敗：$($_.Exception.Message)"
  exit 1
} finally {
  if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
}
```

- [ ] **Step 4: 執行測試，確認全部通過**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File updater\tests\test-update.ps1`
Expected: 六個 `PASS`，最後顯示 `全部通過`，結束碼 0。

- [ ] **Step 5: Commit**

```bash
git add updater/update.ps1 updater/tests/test-update.ps1
git commit -m "feat: 新增自動更新腳本 update.ps1（版本比對、下載覆蓋、備份還原）"
```

---

### Task 2: setup.ps1 — 朋友的一鍵初始安裝

**Files:**
- Create: `updater/setup.ps1`
- Test: `updater/tests/test-setup.ps1`

- [ ] **Step 1: 寫整合測試（setup.ps1 尚不存在，必然失敗）**

建立 `updater/tests/test-setup.ps1`：

```powershell
# setup.ps1 整合測試：以本機 zip 模擬 GitHub，-SkipScheduledTask 避免動到真的排程
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ("MetaReplyProSetupTest_" + [guid]::NewGuid().ToString('N'))
$script:failed = $false

function Assert($condition, $name) {
  if ($condition) { Write-Host "PASS  $name" }
  else { Write-Host "FAIL  $name" -ForegroundColor Red; $script:failed = $true }
}

$setupScript = Join-Path $PSScriptRoot '..\setup.ps1'

# --- 假的 GitHub zip（內含 MetaReplyPro-main\ 根目錄）
$repoDir = Join-Path $root 'MetaReplyPro-main'
New-Item -ItemType Directory -Path (Join-Path $repoDir 'chrome-extension') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $repoDir 'updater') -Force | Out-Null
'{ "version": "1.1.0", "name": "test" }' | Set-Content (Join-Path $repoDir 'chrome-extension\manifest.json') -Encoding utf8
'updater' | Set-Content (Join-Path $repoDir 'updater\update.ps1') -Encoding utf8
$zipPath = Join-Path $root 'main.zip'
Compress-Archive -Path $repoDir -DestinationPath $zipPath

# --- 執行安裝
$installDir = Join-Path $root 'install'
& $setupScript -InstallDir $installDir -ZipUrl $zipPath -SkipScheduledTask

Assert (Test-Path (Join-Path $installDir 'chrome-extension\manifest.json')) '安裝 chrome-extension 資料夾'
Assert (Test-Path (Join-Path $installDir 'update.ps1')) '安裝 update.ps1'
Assert ($LASTEXITCODE -eq 0) '安裝結束碼為 0'

# --- 重複執行應可覆蓋（安裝目錄已存在時不報錯）
& $setupScript -InstallDir $installDir -ZipUrl $zipPath -SkipScheduledTask
Assert ($LASTEXITCODE -eq 0) '重複執行安裝不報錯'

Remove-Item $root -Recurse -Force
if ($script:failed) { Write-Host "`n有測試失敗" -ForegroundColor Red; exit 1 }
else { Write-Host "`n全部通過"; exit 0 }
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File updater\tests\test-setup.ps1`
Expected: 錯誤終止（找不到 `..\setup.ps1`），結束碼非 0。

- [ ] **Step 3: 實作 setup.ps1**

建立 `updater/setup.ps1`：

```powershell
# MetaReplyPro 一鍵安裝腳本
# 用法（開啟 PowerShell 貼上執行）：
#   irm https://raw.githubusercontent.com/Keith0512/MetaReplyPro/main/updater/setup.ps1 | iex
# 會下載擴充功能到 %LOCALAPPDATA%\MetaReplyPro，並建立每天自動更新的排程工作。
param(
  [string]$InstallDir = "$env:LOCALAPPDATA\MetaReplyPro",
  [string]$ZipUrl = 'https://github.com/Keith0512/MetaReplyPro/archive/refs/heads/main.zip',
  [switch]$SkipScheduledTask
)

$ErrorActionPreference = 'Stop'
$tempDir = Join-Path $env:TEMP ("MetaReplyProSetup_" + [guid]::NewGuid().ToString('N'))

try {
  Write-Host "正在安裝 MetaReplyPro 到 $InstallDir ..."
  New-Item -ItemType Directory -Path $tempDir | Out-Null

  # 下載並解壓（來源為本機路徑時直接複製，供測試使用）
  $zipPath = Join-Path $tempDir 'repo.zip'
  if ($ZipUrl -match '^https?://') {
    Invoke-WebRequest -Uri $ZipUrl -OutFile $zipPath -UseBasicParsing
  } else {
    Copy-Item -Path $ZipUrl -Destination $zipPath -Force
  }
  $extractDir = Join-Path $tempDir 'extracted'
  Expand-Archive -Path $zipPath -DestinationPath $extractDir
  $repoRoot = Get-ChildItem -Directory $extractDir | Select-Object -First 1

  # 放置檔案
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $extensionDir = Join-Path $InstallDir 'chrome-extension'
  if (Test-Path $extensionDir) { Remove-Item $extensionDir -Recurse -Force }
  Copy-Item (Join-Path $repoRoot.FullName 'chrome-extension') $extensionDir -Recurse
  Copy-Item (Join-Path $repoRoot.FullName 'updater\update.ps1') (Join-Path $InstallDir 'update.ps1') -Force

  # 建立排程工作：登入時＋每天 12:00 檢查更新
  if (-not $SkipScheduledTask) {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
      -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstallDir\update.ps1`""
    $triggers = @(
      (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"),
      (New-ScheduledTaskTrigger -Daily -At '12:00')
    )
    Register-ScheduledTask -TaskName 'MetaReplyPro Update' -Action $action -Trigger $triggers -Force | Out-Null
    Write-Host '已建立自動更新排程（登入時＋每天 12:00）'
  }

  Write-Host ''
  Write-Host '安裝完成！接下來請手動做一次（只有第一次需要）：'
  Write-Host '  1. 開啟 Chrome，網址列輸入 chrome://extensions'
  Write-Host '  2. 開啟右上角的「開發人員模式」'
  Write-Host "  3. 點「載入未封裝項目」，選擇資料夾：$extensionDir"
  exit 0
} catch {
  Write-Host "安裝失敗：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
}
```

- [ ] **Step 4: 執行測試，確認全部通過**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File updater\tests\test-setup.ps1`
Expected: 四個 `PASS`，最後顯示 `全部通過`，結束碼 0。

- [ ] **Step 5: Commit**

```bash
git add updater/setup.ps1 updater/tests/test-setup.ps1
git commit -m "feat: 新增一鍵安裝腳本 setup.ps1（下載、放置、建立更新排程）"
```

---

### Task 3: 擴充功能自動重載（background.js + manifest）

**Files:**
- Modify: `chrome-extension/manifest.json`（permissions 加 `alarms`；version `1.0.0` → `1.1.0`）
- Modify: `chrome-extension/background.js`（檔尾新增自動重載邏輯）

無自動化測試環境，先實作、後以手動步驟驗證（Step 3）。

- [ ] **Step 1: 修改 manifest.json**

`permissions` 陣列加入 `"alarms"`，`version` 改為 `"1.1.0"`：

```json
  "version": "1.1.0",
  ...
  "permissions": [
    "storage",
    "activeTab",
    "scripting",
    "alarms"
  ],
```

- [ ] **Step 2: 在 background.js 檔尾新增自動重載邏輯**

```javascript
// ---- 未封裝版自動更新 ----
// 未封裝擴充功能的檔案是即時從磁碟讀取的：update.ps1 換完新版檔案後，
// 磁碟上 manifest.json 的版本會與記憶體中執行的版本不同，此時重新載入即可套用新版。
const UPDATE_CHECK_ALARM = "update-check";

function scheduleUpdateCheck() {
  chrome.alarms.create(UPDATE_CHECK_ALARM, { periodInMinutes: 5 });
}
chrome.runtime.onInstalled.addListener(scheduleUpdateCheck);
chrome.runtime.onStartup.addListener(scheduleUpdateCheck);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== UPDATE_CHECK_ALARM) return;
  try {
    const response = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
    const diskManifest = await response.json();
    if (diskManifest.version !== chrome.runtime.getManifest().version) {
      console.log(`Meta Auto Reply: 偵測到新版 ${diskManifest.version}，重新載入`);
      chrome.runtime.reload();
    }
  } catch (e) {
    // 更新腳本可能正在覆蓋檔案，略過本次檢查，下次 alarm 再試
  }
});
```

- [ ] **Step 3: 手動驗證自動重載**

1. Chrome 開 `chrome://extensions` → 載入未封裝項目（選 repo 裡的 `chrome-extension` 資料夾）→ 點「Service Worker」開啟 DevTools console。
2. 在 console 執行以下程式，模擬 alarm 立即觸發前的檢查（磁碟與執行中版本相同，應無動作）：
   ```javascript
   fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" })
     .then(r => r.json())
     .then(m => console.log("disk:", m.version, "running:", chrome.runtime.getManifest().version));
   ```
   Expected: 兩個版本相同（`1.1.0`）。
3. 用編輯器把磁碟上 `chrome-extension/manifest.json` 的 version 暫時改成 `1.1.1`（不要在 Chrome 按重新載入），在 console 執行：
   ```javascript
   chrome.alarms.create("update-check", { delayInMinutes: 0.01 });
   ```
   Expected: 約一秒後擴充功能自動重新載入（DevTools 視窗關閉、`chrome://extensions` 上版本變成 1.1.1）。
4. 把 version 改回 `1.1.0`，在 Chrome 按一次重新載入，回復乾淨狀態。

- [ ] **Step 4: Commit**

```bash
git add chrome-extension/manifest.json chrome-extension/background.js
git commit -m "feat: 擴充功能偵測磁碟新版本自動重新載入（alarms + runtime.reload）"
```

---

### Task 4: 端對端驗證與文件

**Files:**
- Modify: `README.md`（新增「安裝與自動更新」章節）

- [ ] **Step 1: README 新增章節**

在 `README.md` 檔尾加入：

```markdown
## Chrome 擴充功能：安裝與自動更新

### 首次安裝（Windows）

開啟 PowerShell，貼上執行：

​```powershell
irm https://raw.githubusercontent.com/Keith0512/MetaReplyPro/main/updater/setup.ps1 | iex
​```

完成後依畫面指示到 `chrome://extensions` 開啟「開發人員模式」，
用「載入未封裝項目」選擇 `%LOCALAPPDATA%\MetaReplyPro\chrome-extension`（只有第一次需要）。

### 自動更新機制

- 安裝時會建立 Windows 排程工作「MetaReplyPro Update」：登入時與每天 12:00 檢查 GitHub 上的新版本，有新版才下載覆蓋。
- 擴充功能每 5 分鐘比對磁碟上的版本，發現已更新就自動重新載入，使用者不需任何操作。
- 更新紀錄寫在 `%LOCALAPPDATA%\MetaReplyPro\update.log`；上一版備份在 `chrome-extension.backup`。

### 發佈新版（開發者）

1. 修改程式後，把 `chrome-extension/manifest.json` 的 `version` 加一號（例如 `1.1.0` → `1.1.1`）。
2. push 到 `main`。main 分支即正式發佈通道，所有使用者會在下次排程時自動更新。
```

（注意：實際寫入 README 時，程式碼圍欄使用一般的三個反引號，不含上面示意用的零寬字元。）

- [ ] **Step 2: 端對端驗證（在開發機上走一次完整流程）**

前置：repo 已改為 Public、最新程式已 push 到 main。

1. 執行真正的安裝：`powershell -NoProfile -ExecutionPolicy Bypass -File updater\setup.ps1`
2. 確認排程工作存在：`Get-ScheduledTask -TaskName 'MetaReplyPro Update'` → Expected: State `Ready`。
3. Chrome 以 `%LOCALAPPDATA%\MetaReplyPro\chrome-extension` 載入未封裝項目，確認功能正常。
4. 模擬舊版：把 `%LOCALAPPDATA%\MetaReplyPro\chrome-extension\manifest.json` 的 version 改成 `1.0.9`。
5. 手動觸發排程：`Start-ScheduledTask -TaskName 'MetaReplyPro Update'`，等待數秒。
6. 檢查 `%LOCALAPPDATA%\MetaReplyPro\update.log` → Expected: 出現「更新完成：1.0.9 → 1.1.0」。
7. 等最多 5 分鐘（或用 Task 3 Step 3 的 console 指令立即觸發）→ Expected: 擴充功能自動重載為 1.1.0。

- [ ] **Step 3: Commit 與收尾**

```bash
git add README.md
git commit -m "docs: 新增擴充功能安裝與自動更新說明"
```

提醒使用者兩件需要親自做的事：
1. 把 repo 改為 Public（GitHub → Settings → Danger Zone → Change visibility）。
2. 確認要 push 到 GitHub main（push 即發佈）。

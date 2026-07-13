# MetaReplyPro 自動更新腳本
# 由 Windows 排程工作定時執行：比對 GitHub 上的版本，有新版才下載覆蓋本機 chrome-extension\。
# 擴充功能本身會偵測到磁碟檔案變新並自動重新載入（見 background.js）。
param(
  [string]$InstallDir = "$env:LOCALAPPDATA\MetaReplyPro",
  [string]$ManifestUrl = 'https://raw.githubusercontent.com/Keith0512/MetaReplyPro/main/chrome-extension/manifest.json',
  [string]$ZipUrl = 'https://github.com/Keith0512/MetaReplyPro/archive/refs/heads/main.zip',
  [switch]$Interactive  # 手動執行（桌面捷徑）時顯示進度，結束前暫停讓使用者看結果
)

$ErrorActionPreference = 'Stop'

# 互動模式下結束前暫停，讓使用者看得到結果再關視窗
function Wait-IfInteractive {
  if ($Interactive) { Write-Host ''; Read-Host '按 Enter 關閉視窗' | Out-Null }
}

if (-not (Test-Path $InstallDir)) {
  Write-Host "找不到安裝目錄 $InstallDir，請先執行 setup.ps1"
  Wait-IfInteractive
  exit 1
}

$logFile = Join-Path $InstallDir 'update.log'
function Write-Log([string]$Message) {
  Add-Content -Path $logFile -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $Message) -Encoding utf8
  if ($Interactive) { Write-Host $Message }
}

if ($Interactive) { Write-Host '正在檢查 MetaReplyPro 更新…' }

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
    Wait-IfInteractive
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

  # 最後更新腳本自身與橋接程式（PowerShell 執行前已解析完整個檔案，覆寫執行中的腳本是安全的）
  foreach ($name in @('update.ps1', 'update-host.ps1', 'update-host.bat')) {
    $src = Join-Path $repoRoot.FullName "updater\$name"
    if (Test-Path $src) { Copy-Item $src (Join-Path $InstallDir $name) -Force }
  }

  Write-Log "更新完成：$localVersion → $remoteVersion"
  if ($Interactive) { Write-Host '擴充功能會在幾分鐘內自動重新載入，不需要手動操作。' }
  Wait-IfInteractive
  exit 0
} catch {
  Write-Log "更新失敗：$($_.Exception.Message)（倉庫可能未開放，請聯絡管理員）"
  Wait-IfInteractive
  exit 1
} finally {
  if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
}

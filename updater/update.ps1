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

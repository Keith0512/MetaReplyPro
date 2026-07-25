# MetaReplyPro 本機安裝腳本
# 必須從已驗證、解壓後的正式 release 資料夾執行；不再從浮動的 GitHub main 下載程式。
param(
  [string]$InstallDir = "$env:LOCALAPPDATA\MetaReplyPro",
  [string]$SourceDir = (Split-Path $PSScriptRoot -Parent),
  [string]$DesktopDir = [Environment]::GetFolderPath('Desktop'),
  [switch]$EnableScheduledTask,
  [switch]$SkipScheduledTaskManagement,
  [switch]$SkipRegistry,
  [switch]$SkipDesktopShortcut
)

$ErrorActionPreference = 'Stop'
$extensionId = 'gnekicgafkpbmafejjcbaagcpfnmfjbh'

try {
  Write-Host "正在從已驗證的 release 安裝 MetaReplyPro 到 $InstallDir ..."

  $releaseInfoPath = Join-Path $SourceDir 'release-info.json'
  $sourceExtensionDir = Join-Path $SourceDir 'chrome-extension'
  $sourceUpdaterDir = Join-Path $SourceDir 'updater'
  $sourceManifestPath = Join-Path $sourceExtensionDir 'manifest.json'
  $sourceTrustedKeyPath = Join-Path $sourceUpdaterDir 'trusted-update-key.json'
  if (-not (Test-Path -LiteralPath $releaseInfoPath)) {
    throw '安裝來源缺少 release-info.json；請使用已簽章的正式 release'
  }
  if (-not (Test-Path -LiteralPath $sourceManifestPath)) {
    throw '安裝來源缺少 chrome-extension\manifest.json'
  }
  if (-not (Test-Path -LiteralPath $sourceTrustedKeyPath)) {
    throw '安裝來源缺少 trusted-update-key.json'
  }

  $releaseInfo = Get-Content -LiteralPath $releaseInfoPath -Raw -Encoding utf8 | ConvertFrom-Json
  $extensionManifest = Get-Content -LiteralPath $sourceManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
  if (
    [int]$releaseInfo.schemaVersion -ne 1 -or
    [string]$releaseInfo.commit -notmatch '^[0-9a-f]{40}$' -or
    [string]$releaseInfo.version -ne [string]$extensionManifest.version
  ) {
    throw 'release-info.json 與擴充功能內容不一致'
  }

  $updaterFiles = @(
    'update.ps1',
    'update-host.ps1',
    'update-host.bat',
    'disable-auto-update.ps1',
    'trusted-update-key.json'
  )
  foreach ($name in $updaterFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceUpdaterDir $name))) {
      throw "安裝來源缺少 updater\$name"
    }
  }

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $extensionDir = Join-Path $InstallDir 'chrome-extension'
  $extensionStagingDir = Join-Path $InstallDir 'chrome-extension.installing'
  if (Test-Path -LiteralPath $extensionStagingDir) {
    Remove-Item -LiteralPath $extensionStagingDir -Recurse -Force
  }
  Copy-Item -LiteralPath $sourceExtensionDir -Destination $extensionStagingDir -Recurse
  if (Test-Path -LiteralPath $extensionDir) {
    Remove-Item -LiteralPath $extensionDir -Recurse -Force
  }
  Move-Item -LiteralPath $extensionStagingDir -Destination $extensionDir

  foreach ($name in $updaterFiles) {
    Copy-Item -LiteralPath (Join-Path $sourceUpdaterDir $name) -Destination (Join-Path $InstallDir $name) -Force
  }
  Copy-Item -LiteralPath $releaseInfoPath -Destination (Join-Path $InstallDir 'release-info.json') -Force

  $hostManifestPath = Join-Path $InstallDir 'com.metareplypro.updater.json'
  $hostManifest = @{
    name            = 'com.metareplypro.updater'
    description     = 'MetaReplyPro signed release updater'
    path            = (Join-Path $InstallDir 'update-host.bat')
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$extensionId/")
  } | ConvertTo-Json
  [IO.File]::WriteAllText($hostManifestPath, $hostManifest, [Text.UTF8Encoding]::new($false))

  if (-not $SkipRegistry) {
    $regPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.metareplypro.updater'
    New-Item -Path $regPath -Force | Out-Null
    Set-ItemProperty -Path $regPath -Name '(default)' -Value $hostManifestPath
  }

  if (-not $SkipDesktopShortcut) {
    $shortcutPath = Join-Path $DesktopDir 'MetaReplyPro 更新.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = 'powershell.exe'
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\update.ps1`" -Interactive"
    $shortcut.WorkingDirectory = $InstallDir
    $shortcut.IconLocation = 'powershell.exe,0'
    $shortcut.Save()
  }

  if ($SkipScheduledTaskManagement) {
    Write-Host '已略過排程工作管理'
  } elseif ($EnableScheduledTask) {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
      -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstallDir\update.ps1`""
    $triggers = @(
      (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"),
      (New-ScheduledTaskTrigger -Daily -At '12:00')
    )
    Register-ScheduledTask -TaskName 'MetaReplyPro Update' -Action $action -Trigger $triggers -Force | Out-Null
    Write-Host '已啟用自動更新排程（登入時＋每天 12:00）；每次更新仍會驗證簽章與 SHA-256'
  } else {
    $existingTask = Get-ScheduledTask -TaskName 'MetaReplyPro Update' -ErrorAction SilentlyContinue
    if ($existingTask) {
      Disable-ScheduledTask -TaskName 'MetaReplyPro Update' -ErrorAction Stop | Out-Null
      Write-Host '已停用既有的自動更新排程'
    } else {
      Write-Host '自動更新排程預設不啟用'
    }
  }

  try { Set-Clipboard -Value $extensionDir -ErrorAction Stop } catch { }

  Write-Host ''
  Write-Host "安裝完成：MetaReplyPro $($extensionManifest.version)"
  Write-Host '接下來請手動做一次（只有第一次需要）：'
  Write-Host '  1. 開啟 Chrome，網址列輸入 chrome://extensions'
  Write-Host '  2. 開啟右上角的「開發人員模式」'
  Write-Host '  3. 點「載入未封裝項目」，貼上已複製的資料夾路徑：'
  Write-Host "     $extensionDir"
  Write-Host ''
  Write-Host '日後請從設定頁按「立即更新」，或使用桌面的更新捷徑。'
  Write-Host '更新器會先驗證 release 簽章、commit、版本與 SHA-256。'
  exit 0
} catch {
  Write-Host "安裝失敗：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

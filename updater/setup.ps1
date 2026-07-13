# MetaReplyPro 一鍵安裝腳本
# 用法（開啟 PowerShell 貼上執行）：
#   irm https://raw.githubusercontent.com/Keith0512/MetaReplyPro/main/updater/setup.ps1 | iex
# 會下載擴充功能到 %LOCALAPPDATA%\MetaReplyPro，並建立每天自動更新的排程工作。
param(
  [string]$InstallDir = "$env:LOCALAPPDATA\MetaReplyPro",
  [string]$ZipUrl = 'https://github.com/Keith0512/MetaReplyPro/archive/refs/heads/main.zip',
  [string]$DesktopDir = [Environment]::GetFolderPath('Desktop'),
  [switch]$SkipScheduledTask,
  [switch]$SkipRegistry
)

# 擴充功能的固定 ID（由 manifest.json 的 key 欄位決定），native host 只允許它呼叫
$extensionId = 'gnekicgafkpbmafejjcbaagcpfnmfjbh'

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
  Copy-Item (Join-Path $repoRoot.FullName 'updater\update-host.ps1') (Join-Path $InstallDir 'update-host.ps1') -Force
  Copy-Item (Join-Path $repoRoot.FullName 'updater\update-host.bat') (Join-Path $InstallDir 'update-host.bat') -Force

  # Native Messaging host manifest：讓設定頁的「立即更新」按鈕能呼叫本機更新程式
  $hostManifestPath = Join-Path $InstallDir 'com.metareplypro.updater.json'
  $hostManifest = @{
    name            = 'com.metareplypro.updater'
    description     = 'MetaReplyPro one-click updater'
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

  # 建立桌面「MetaReplyPro 更新」捷徑：同事點兩下即可手動更新（互動模式會顯示結果）
  $shortcutPath = Join-Path $DesktopDir 'MetaReplyPro 更新.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = 'powershell.exe'
  $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\update.ps1`" -Interactive"
  $shortcut.WorkingDirectory = $InstallDir
  $shortcut.IconLocation = 'powershell.exe,0'
  $shortcut.Save()

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
  Write-Host ''
  Write-Host '之後要更新時，點兩下桌面的「MetaReplyPro 更新」捷徑即可。'
  exit 0
} catch {
  Write-Host "安裝失敗：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
}

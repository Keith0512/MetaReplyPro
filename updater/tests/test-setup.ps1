# setup.ps1 整合測試：只允許從本機已驗證的 release 來源安裝。
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ("MetaReplyProSetupTest_" + [guid]::NewGuid().ToString('N'))
$script:failed = $false

function Assert($condition, $name) {
  if ($condition) { Write-Host "PASS  $name" }
  else { Write-Host "FAIL  $name" -ForegroundColor Red; $script:failed = $true }
}

$setupScript = Join-Path $PSScriptRoot '..\setup.ps1'
$sourceDir = Join-Path $root 'MetaReplyPro-v1.5.0'
$sourceExtensionDir = Join-Path $sourceDir 'chrome-extension'
$sourceUpdaterDir = Join-Path $sourceDir 'updater'
New-Item -ItemType Directory -Path $sourceExtensionDir -Force | Out-Null
New-Item -ItemType Directory -Path $sourceUpdaterDir -Force | Out-Null
'{ "version": "1.5.0", "name": "test" }' |
  Set-Content (Join-Path $sourceExtensionDir 'manifest.json') -Encoding utf8
@{
  schemaVersion = 1
  version = '1.5.0'
  commit = '1111111111111111111111111111111111111111'
} | ConvertTo-Json | Set-Content (Join-Path $sourceDir 'release-info.json') -Encoding utf8
foreach ($name in @('update.ps1', 'update-host.ps1', 'update-host.bat', 'disable-auto-update.ps1', 'trusted-update-key.json')) {
  Copy-Item (Join-Path $PSScriptRoot "..\$name") (Join-Path $sourceUpdaterDir $name)
}

$installDir = Join-Path $root 'install'
$desktopDir = Join-Path $root 'desktop'
New-Item -ItemType Directory -Path $desktopDir -Force | Out-Null
$isWindowsPlatform = (-not (Test-Path variable:IsWindows)) -or $IsWindows
$setupArguments = @{
  InstallDir = $installDir
  SourceDir = $sourceDir
  SkipScheduledTaskManagement = $true
  SkipRegistry = $true
  DesktopDir = $desktopDir
}
if (-not $isWindowsPlatform) {
  $setupArguments.SkipDesktopShortcut = $true
}

try {
  & $setupScript @setupArguments

  Assert ($LASTEXITCODE -eq 0) '安裝結束碼為 0'
  Assert (Test-Path (Join-Path $installDir 'chrome-extension\manifest.json')) '安裝 chrome-extension 資料夾'
  Assert (Test-Path (Join-Path $installDir 'update.ps1')) '安裝安全 update.ps1'
  Assert (Test-Path (Join-Path $installDir 'trusted-update-key.json')) '安裝固定更新公開金鑰'
  Assert (Test-Path (Join-Path $installDir 'release-info.json')) '保留安裝版本與 commit 資訊'

  $hostManifestPath = Join-Path $installDir 'com.metareplypro.updater.json'
  Assert (Test-Path $hostManifestPath) '產生 native host manifest'
  $hostManifest = Get-Content $hostManifestPath -Raw | ConvertFrom-Json
  Assert ($hostManifest.name -eq 'com.metareplypro.updater') 'host manifest 名稱正確'
  Assert ($hostManifest.path -eq (Join-Path $installDir 'update-host.bat')) 'host manifest 指向安裝目錄'
  Assert (@($hostManifest.allowed_origins) -contains 'chrome-extension://gnekicgafkpbmafejjcbaagcpfnmfjbh/') 'host 只允許固定擴充功能 ID'

  if ($isWindowsPlatform) {
    $shortcutPath = Join-Path $desktopDir 'MetaReplyPro 更新.lnk'
    Assert (Test-Path $shortcutPath) '建立桌面安全更新捷徑'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    Assert ($shortcut.Arguments -match 'update\.ps1' -and $shortcut.Arguments -match '-Interactive') '捷徑以互動模式執行安全更新器'
  }

  & $setupScript @setupArguments
  Assert ($LASTEXITCODE -eq 0) '重複執行可信 release 安裝不報錯'

  $invalidSource = Join-Path $root 'invalid'
  New-Item -ItemType Directory -Path $invalidSource | Out-Null
  $invalidArguments = $setupArguments.Clone()
  $invalidArguments.InstallDir = Join-Path $root 'rejected'
  $invalidArguments.SourceDir = $invalidSource
  & $setupScript @invalidArguments
  Assert ($LASTEXITCODE -ne 0) '缺少 release-info.json 的來源會被拒絕'
} finally {
  if (Test-Path $root) { Remove-Item $root -Recurse -Force }
}

if ($script:failed) { Write-Host "`n有測試失敗" -ForegroundColor Red; exit 1 }
else { Write-Host "`n全部通過"; exit 0 }

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
'host-ps1' | Set-Content (Join-Path $repoDir 'updater\update-host.ps1') -Encoding utf8
'host-bat' | Set-Content (Join-Path $repoDir 'updater\update-host.bat') -Encoding utf8
$zipPath = Join-Path $root 'main.zip'
Compress-Archive -Path $repoDir -DestinationPath $zipPath

# --- 執行安裝
$installDir = Join-Path $root 'install'
$desktopDir = Join-Path $root 'desktop'
New-Item -ItemType Directory -Path $desktopDir -Force | Out-Null
& $setupScript -InstallDir $installDir -ZipUrl $zipPath -SkipScheduledTask -SkipRegistry -DesktopDir $desktopDir

Assert (Test-Path (Join-Path $installDir 'chrome-extension\manifest.json')) '安裝 chrome-extension 資料夾'
Assert (Test-Path (Join-Path $installDir 'update.ps1')) '安裝 update.ps1'
Assert ($LASTEXITCODE -eq 0) '安裝結束碼為 0'

# --- Native Messaging host：檔案與 manifest
Assert (Test-Path (Join-Path $installDir 'update-host.ps1')) '安裝 update-host.ps1'
Assert (Test-Path (Join-Path $installDir 'update-host.bat')) '安裝 update-host.bat'
$hostManifestPath = Join-Path $installDir 'com.metareplypro.updater.json'
Assert (Test-Path $hostManifestPath) '產生 native host manifest'
$hm = Get-Content $hostManifestPath -Raw | ConvertFrom-Json
Assert ($hm.name -eq 'com.metareplypro.updater') 'host manifest 名稱正確'
Assert ($hm.path -eq (Join-Path $installDir 'update-host.bat')) 'host manifest path 指向安裝目錄的 update-host.bat'
Assert (@($hm.allowed_origins) -contains 'chrome-extension://gnekicgafkpbmafejjcbaagcpfnmfjbh/') 'host manifest 允許固定擴充功能 ID'

# --- 建立桌面更新捷徑，且指向 update.ps1 互動模式
$shortcutPath = Join-Path $desktopDir 'MetaReplyPro 更新.lnk'
Assert (Test-Path $shortcutPath) '建立桌面「MetaReplyPro 更新」捷徑'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
Assert ($shortcut.Arguments -match 'update\.ps1' -and $shortcut.Arguments -match '-Interactive') '捷徑以互動模式執行 update.ps1'

# --- 重複執行應可覆蓋（安裝目錄已存在時不報錯）
& $setupScript -InstallDir $installDir -ZipUrl $zipPath -SkipScheduledTask -SkipRegistry -DesktopDir $desktopDir
Assert ($LASTEXITCODE -eq 0) '重複執行安裝不報錯'

Remove-Item $root -Recurse -Force
if ($script:failed) { Write-Host "`n有測試失敗" -ForegroundColor Red; exit 1 }
else { Write-Host "`n全部通過"; exit 0 }

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

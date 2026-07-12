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

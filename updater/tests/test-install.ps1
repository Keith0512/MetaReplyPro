# install.ps1 安全回歸測試：安裝器只執行同一個已驗證 release 內的 setup.ps1。
$ErrorActionPreference = 'Stop'
$script:failed = $false

function Assert($condition, $name) {
  if ($condition) { Write-Host "PASS  $name" }
  else { Write-Host "FAIL  $name" -ForegroundColor Red; $script:failed = $true }
}

$installPs1 = Join-Path $PSScriptRoot '..\install.ps1'
$setupPs1 = Join-Path $PSScriptRoot '..\setup.ps1'
$updatePs1 = Join-Path $PSScriptRoot '..\update.ps1'

$bytes = [IO.File]::ReadAllBytes($installPs1)
$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
Assert (-not $hasBom) 'install.ps1 無 UTF-8 BOM'
Assert (@($bytes | Where-Object { $_ -gt 127 }).Count -eq 0) 'install.ps1 全為 ASCII'

$text = [IO.File]::ReadAllText($installPs1)
Assert ($text -notmatch 'Invoke-WebRequest|Invoke-RestMethod|\birm\b|raw\.githubusercontent|main\.zip') 'install.ps1 不下載或執行浮動 main'
Assert ($text -match 'release-info\.json') 'install.ps1 要求正式 release 資訊'
Assert ($text -match 'setup\.ps1') 'install.ps1 只呼叫同一 release 內的 setup.ps1'
Assert ($text -match '-SourceDir') 'install.ps1 將本機 release 根目錄傳給 setup.ps1'

$parseOk = $true
try { [scriptblock]::Create($text) | Out-Null } catch { $parseOk = $false }
Assert $parseOk 'install.ps1 可被 PowerShell 解析'

foreach ($file in @($setupPs1, $updatePs1)) {
  $fileBytes = [IO.File]::ReadAllBytes($file)
  Assert (
    $fileBytes.Length -ge 3 -and
    $fileBytes[0] -eq 0xEF -and
    $fileBytes[1] -eq 0xBB -and
    $fileBytes[2] -eq 0xBF
  ) "$(Split-Path $file -Leaf) 保留 UTF-8 BOM"
}

if ($script:failed) { Write-Host "`n有測試失敗" -ForegroundColor Red; exit 1 }
else { Write-Host "`n全部通過"; exit 0 }

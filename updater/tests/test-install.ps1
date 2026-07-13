# install.ps1 回歸測試：鎖定「UTF-8 BOM 導致 irm | iex 解析失敗」的根因
# install.ps1 是給 `irm <url> | iex` 執行的引導安裝器，必須維持：
#   純 ASCII、無 BOM（BOM 會讓 iex 認不出 param 等首語句）、
#   無 param 區塊、無 exit（iex 模式下 exit 會關閉使用者整個 PowerShell 視窗）。
$ErrorActionPreference = 'Stop'
$script:failed = $false

function Assert($condition, $name) {
  if ($condition) { Write-Host "PASS  $name" }
  else { Write-Host "FAIL  $name" -ForegroundColor Red; $script:failed = $true }
}

$installPs1 = Join-Path $PSScriptRoot '..\install.ps1'
$setupPs1   = Join-Path $PSScriptRoot '..\setup.ps1'
$updatePs1  = Join-Path $PSScriptRoot '..\update.ps1'

Assert (Test-Path $installPs1) 'install.ps1 存在'

# --- iex 相容性：無 BOM、全 ASCII
$bytes = [IO.File]::ReadAllBytes($installPs1)
$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
Assert (-not $hasBom) 'install.ps1 無 UTF-8 BOM'
Assert (@($bytes | Where-Object { $_ -gt 127 }).Count -eq 0) 'install.ps1 全為 ASCII'

# --- iex 相容性：無 param 區塊、無 exit
$text = [IO.File]::ReadAllText($installPs1)
Assert ($text -notmatch '(?m)^\s*param\s*\(') 'install.ps1 不含 param 區塊'
Assert ($text -notmatch '(?m)^\s*exit\b') 'install.ps1 不含 exit'

# --- 模擬 irm | iex 的解析（iex 內部同樣以 scriptblock 解析字串）
$parseOk = $true
try { [scriptblock]::Create($text) | Out-Null } catch { $parseOk = $false }
Assert $parseOk 'install.ps1 可被 iex 解析'

# --- 必須指向 setup.ps1 的 raw 網址並以 -File 執行
Assert ($text -match 'raw\.githubusercontent\.com/Keith0512/MetaReplyPro/main/updater/setup\.ps1') 'install.ps1 指向 setup.ps1 raw 網址'
Assert ($text -match '-File') 'install.ps1 以 -File 執行 setup.ps1'

# --- setup.ps1 / update.ps1 只走 -File 路徑，必須「保留」BOM（PS 5.1 無 BOM 會把中文讀壞）
foreach ($f in @($setupPs1, $updatePs1)) {
  $b = [IO.File]::ReadAllBytes($f)
  Assert ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) "$(Split-Path $f -Leaf) 保留 UTF-8 BOM"
}

if ($script:failed) { Write-Host "`n有測試失敗" -ForegroundColor Red; exit 1 }
else { Write-Host "`n全部通過"; exit 0 }

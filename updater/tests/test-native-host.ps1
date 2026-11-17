# update-host.ps1 整合測試：模擬 Chrome Native Messaging 的 stdio 協議
# （4 bytes little-endian 長度 + UTF-8 JSON），以 stub update.ps1 取代真實更新。
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ("MetaReplyProHostTest_" + [guid]::NewGuid().ToString('N'))
$script:failed = $false

function Assert($condition, $name) {
  if ($condition) { Write-Host "PASS  $name" }
  else { Write-Host "FAIL  $name" -ForegroundColor Red; $script:failed = $true }
}

# 解析 host 回應：回傳 payload 物件；框架錯誤回 $null
function Read-HostResponse([byte[]]$Bytes) {
  if ($bytes.Length -lt 4) { return $null }
  $len = [BitConverter]::ToInt32($bytes, 0)
  if ($len -ne ($bytes.Length - 4)) { return $null }
  return ([Text.Encoding]::UTF8.GetString($bytes, 4, $len) | ConvertFrom-Json)
}

function New-HostFrame([hashtable]$Message) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($Message | ConvertTo-Json -Compress))
  [BitConverter]::GetBytes([int]$bytes.Length) + $bytes
}

function Invoke-Host([string]$Directory, [byte[]]$Frame) {
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = 'powershell.exe'
  $hostPath = Join-Path $Directory 'update-host-pinned.ps1'
  $start.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$hostPath`""
  $start.UseShellExecute = $false
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  # .NET Framework's redirect writer may emit a BOM before the binary frame.
  $originalEncoding = [Console]::InputEncoding
  try {
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    $process = [Diagnostics.Process]::Start($start)
  } finally {
    [Console]::InputEncoding = $originalEncoding
  }
  $output = New-Object IO.MemoryStream
  try {
    $readOutput = $process.StandardOutput.BaseStream.CopyToAsync($output)
    $process.StandardInput.BaseStream.Write($Frame, 0, $Frame.Length)
    $process.StandardInput.Close()
    $process.WaitForExit()
    $readOutput.GetAwaiter().GetResult()
    Read-HostResponse ($output.ToArray())
  } finally {
    $output.Dispose()
    $process.Dispose()
  }
}

# 建立測試環境：host 腳本 + stub update.ps1 + 假 manifest
function New-HostFixture([string]$Name, [string]$StubBody) {
  $dir = Join-Path $root $Name
  New-Item -ItemType Directory -Path (Join-Path $dir 'chrome-extension') -Force | Out-Null
  Copy-Item (Join-Path $PSScriptRoot '..\update-host.ps1') (Join-Path $dir 'update-host-pinned.ps1')
  '{ "version": "1.0.0" }' | Set-Content (Join-Path $dir 'chrome-extension\manifest.json') -Encoding utf8
  $StubBody | Set-Content (Join-Path $dir 'update-pinned.ps1') -Encoding utf8
  @'
'called' | Set-Content (Join-Path $PSScriptRoot 'legacy-called.txt')
exit 1
'@ | Set-Content (Join-Path $dir 'update.ps1') -Encoding utf8
  return $dir
}

$manifestSha256 = 'a' * 64
$update = New-HostFrame @{ action = 'update'; version = '9.9.9'; manifestSha256 = $manifestSha256 }
$stubOk = @'
param([string]$InstallDir, [string]$ExpectedVersion, [string]$ExpectedManifestSha256, [switch]$Preview)
if ($InstallDir -ne $PSScriptRoot -or $ExpectedVersion -ne '9.9.9') { exit 1 }
if ($Preview) {
  @{ ok = $true; version = $ExpectedVersion; manifestSha256 = 'a' * 64 } | ConvertTo-Json -Compress
  exit 0
}
if ($ExpectedManifestSha256 -ne ('a' * 64)) { exit 1 }
Set-Content -Path (Join-Path $PSScriptRoot 'chrome-extension\manifest.json') -Value '{ "version": "9.9.9" }' -Encoding utf8
'called' | Set-Content (Join-Path $PSScriptRoot 'stub-called.txt')
exit 0
'@
try {
  $dir = New-HostFixture 'ok' $stubOk
  $resp = Invoke-Host $dir (New-HostFrame @{ action = 'preview'; version = '9.9.9' })
  Assert ($resp.ok -eq $true -and $resp.version -eq '9.9.9' -and
    $resp.manifestSha256 -eq $manifestSha256) 'host 回傳驗證的預覽資料'
  Assert (-not (Test-Path (Join-Path $dir 'stub-called.txt'))) '預覽未安裝更新'

  $resp = Invoke-Host $dir $update
  Assert (Test-Path (Join-Path $dir 'stub-called.txt')) 'host 傳入確認過的版本與 manifest SHA-256'
  Assert ($null -ne $resp) '回應符合 4-byte 長度前綴框架'
  Assert ($resp.ok -eq $true -and $resp.updated -eq $true) '更新成功時 updated=true'
  Assert ($resp.before -eq '1.0.0' -and $resp.after -eq '9.9.9') '回報 before/after 版本'
  Assert (-not (Test-Path (Join-Path $dir 'legacy-called.txt'))) 'host 不會呼叫舊版更新器'

  $resp = Invoke-Host (New-HostFixture 'latest' 'exit 0') $update
  Assert ($resp.ok -eq $true -and $resp.updated -eq $false) '無新版時 updated=false'

  $resp = Invoke-Host (New-HostFixture 'fail' 'exit 1') $update
  Assert ($resp.ok -eq $false) '更新失敗時 ok=false'

  $dir = New-HostFixture 'rejected' @'
'called' | Set-Content (Join-Path $PSScriptRoot 'stub-called.txt')
exit 0
'@
  $resp = Invoke-Host $dir @()
  Assert ($resp.ok -eq $false) '讀不到訊息時拒絕更新'
  $resp = Invoke-Host $dir (New-HostFrame @{ action = 'update' })
  Assert ($resp.ok -eq $false) '拒絕舊版未確認的更新請求'
  $resp = Invoke-Host $dir (New-HostFrame @{ action = 'update'; version = '9.9.9' })
  Assert ($resp.ok -eq $false) '拒絕缺少 manifest SHA-256 的更新'
  $resp = Invoke-Host $dir (New-HostFrame @{ action = 'unexpected'; version = '9.9.9' })
  Assert ($resp.ok -eq $false) '拒絕未知的更新動作'
  Assert (-not (Test-Path (Join-Path $dir 'stub-called.txt'))) '無效請求未呼叫更新器'

  $b = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot '..\update-host.ps1'))
  Assert ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) 'update-host.ps1 保留 UTF-8 BOM'
} finally {
  if (Test-Path $root) { Remove-Item $root -Recurse -Force }
}
if ($script:failed) { Write-Host "`n有測試失敗" -ForegroundColor Red; exit 1 }
else { Write-Host "`n全部通過"; exit 0 }

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
function Read-HostResponse([string]$OutFile) {
  $bytes = [IO.File]::ReadAllBytes($OutFile)
  if ($bytes.Length -lt 4) { return $null }
  $len = [BitConverter]::ToInt32($bytes, 0)
  if ($len -ne ($bytes.Length - 4)) { return $null }
  return ([Text.Encoding]::UTF8.GetString($bytes, 4, $len) | ConvertFrom-Json)
}

# 建立測試環境：host 腳本 + stub update.ps1 + 假 manifest
function New-HostFixture([string]$Name, [string]$StubBody) {
  $dir = Join-Path $root $Name
  New-Item -ItemType Directory -Path (Join-Path $dir 'chrome-extension') -Force | Out-Null
  Copy-Item (Join-Path $PSScriptRoot '..\update-host.ps1') (Join-Path $dir 'update-host.ps1')
  '{ "version": "1.0.0" }' | Set-Content (Join-Path $dir 'chrome-extension\manifest.json') -Encoding utf8
  $StubBody | Set-Content (Join-Path $dir 'update.ps1') -Encoding utf8
  return $dir
}

# Chrome 送來的訊息：長度前綴 + {"action":"update"}
$msgJson = '{"action":"update"}'
$msgBytes = [Text.Encoding]::UTF8.GetBytes($msgJson)
$msgFile = Join-Path $root 'msg.bin'
New-Item -ItemType Directory -Path $root -Force | Out-Null
$frame = [BitConverter]::GetBytes([int]$msgBytes.Length) + $msgBytes
[IO.File]::WriteAllBytes($msgFile, $frame)

# --- 測試 1：更新成功（stub 改寫 manifest 版本並 exit 0）→ ok=true, updated=true
$stubOk = @'
Set-Content -Path (Join-Path $PSScriptRoot 'chrome-extension\manifest.json') -Value '{ "version": "9.9.9" }' -Encoding utf8
'called' | Set-Content (Join-Path $PSScriptRoot 'stub-called.txt')
exit 0
'@
$dir = New-HostFixture 'ok' $stubOk
$outFile = Join-Path $dir 'out.bin'
cmd /c "powershell -NoProfile -ExecutionPolicy Bypass -File `"$dir\update-host.ps1`" < `"$msgFile`" > `"$outFile`""
$resp = Read-HostResponse $outFile
Assert (Test-Path (Join-Path $dir 'stub-called.txt')) 'host 有執行 update.ps1'
Assert ($null -ne $resp) '回應符合 4-byte 長度前綴框架'
Assert ($resp -and $resp.ok -eq $true) '更新成功時 ok=true'
Assert ($resp -and $resp.updated -eq $true) '版本有變時 updated=true'
Assert ($resp -and $resp.before -eq '1.0.0' -and $resp.after -eq '9.9.9') '回報 before/after 版本'

# --- 測試 2：已是最新（stub 不改版本、exit 0）→ ok=true, updated=false
$dir = New-HostFixture 'latest' 'exit 0'
$outFile = Join-Path $dir 'out.bin'
cmd /c "powershell -NoProfile -ExecutionPolicy Bypass -File `"$dir\update-host.ps1`" < `"$msgFile`" > `"$outFile`""
$resp = Read-HostResponse $outFile
Assert ($resp -and $resp.ok -eq $true -and $resp.updated -eq $false) '無新版時 ok=true, updated=false'

# --- 測試 3：更新失敗（stub exit 1）→ ok=false
$dir = New-HostFixture 'fail' 'exit 1'
$outFile = Join-Path $dir 'out.bin'
cmd /c "powershell -NoProfile -ExecutionPolicy Bypass -File `"$dir\update-host.ps1`" < `"$msgFile`" > `"$outFile`""
$resp = Read-HostResponse $outFile
Assert ($resp -and $resp.ok -eq $false) '更新失敗時 ok=false'

# --- 測試 4：stdin 直接 EOF（讀不到訊息）也要能運作並回應
$dir = New-HostFixture 'eof' $stubOk
$outFile = Join-Path $dir 'out.bin'
$emptyFile = Join-Path $root 'empty.bin'
[IO.File]::WriteAllBytes($emptyFile, @())
cmd /c "powershell -NoProfile -ExecutionPolicy Bypass -File `"$dir\update-host.ps1`" < `"$emptyFile`" > `"$outFile`""
$resp = Read-HostResponse $outFile
Assert ($resp -and $resp.ok -eq $true) '讀不到訊息時仍執行並正常回應'

# --- 測試 5：update-host.ps1 檔案保留 UTF-8 BOM（-File 路徑的中文需要）
$b = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot '..\update-host.ps1'))
Assert ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) 'update-host.ps1 保留 UTF-8 BOM'

Remove-Item $root -Recurse -Force
if ($script:failed) { Write-Host "`n有測試失敗" -ForegroundColor Red; exit 1 }
else { Write-Host "`n全部通過"; exit 0 }

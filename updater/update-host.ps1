# MetaReplyPro Native Messaging 橋接程式
# Chrome 擴充功能透過 stdio 呼叫本程式（訊息格式：4 bytes little-endian 長度 + UTF-8 JSON）。
# 讀取指定版本的預覽或安裝請求，並回覆結果 JSON 給擴充功能。
# 注意：stdout 只能輸出協議框架內容，任何多餘輸出都會讓 Chrome 中斷連線。
$ErrorActionPreference = 'Stop'

$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

function Send-Message([hashtable]$Obj) {
  $json = ConvertTo-Json $Obj -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $len = [BitConverter]::GetBytes([int]$bytes.Length)
  $stdout.Write($len, 0, 4)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

function Read-Exactly([byte[]]$Buffer) {
  $total = 0
  while ($total -lt $Buffer.Length) {
    $n = $stdin.Read($Buffer, $total, $Buffer.Length - $total)
    if ($n -le 0) { throw 'Native Messaging 訊息內容不完整' }
    $total += $n
  }
}

try {
  $lenBuf = New-Object byte[] 4
  Read-Exactly $lenBuf
  $msgLen = [BitConverter]::ToInt32($lenBuf, 0)
  if ($msgLen -le 0 -or $msgLen -gt 1MB) { throw 'Native Messaging 訊息格式無效' }
  $msgBuf = New-Object byte[] $msgLen
  Read-Exactly $msgBuf
  $utf8 = [Text.UTF8Encoding]::new($false, $true)
  $message = $utf8.GetString($msgBuf) | ConvertFrom-Json

  if ($message.action -cne 'preview' -and $message.action -cne 'update') {
    throw '不支援的更新動作'
  }
  if ($message.version -isnot [string] -or $message.version -cnotmatch '^[0-9]+(\.[0-9]+){2,3}\z') {
    throw '更新請求缺少有效版本'
  }

  $updaterPath = Join-Path $PSScriptRoot 'update-pinned.ps1'
  $updaterArgs = @('-InstallDir', $PSScriptRoot, '-ExpectedVersion', $message.version)
  if ($message.action -ceq 'preview') {
    $preview = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updaterPath @updaterArgs -Preview
    if ($LASTEXITCODE -ne 0) { throw '無法驗證該版本的發布資料' }
    $result = $preview | ConvertFrom-Json
    Send-Message @{ ok = $result.ok; version = $result.version; manifestSha256 = $result.manifestSha256 }
    return
  }
  if ($message.manifestSha256 -isnot [string] -or $message.manifestSha256 -cnotmatch '^[0-9a-f]{64}\z') {
    throw '更新請求缺少已確認的發布資料 SHA-256'
  }

  $manifestPath = Join-Path $PSScriptRoot 'chrome-extension\manifest.json'
  function Get-LocalVersion {
    if (Test-Path $manifestPath) {
      (Get-Content $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json).version
    } else { $null }
  }

  $before = Get-LocalVersion
  # 子行程執行更新；其 stdout 丟棄以免污染協議
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updaterPath @updaterArgs `
    -ExpectedManifestSha256 $message.manifestSha256 | Out-Null
  $code = $LASTEXITCODE
  $after = Get-LocalVersion

  if ($code -eq 0) {
    Send-Message @{ ok = $true; updated = ($before -ne $after); before = $before; after = $after }
  } else {
    Send-Message @{ ok = $false; message = '無法驗證或安裝已確認的發布版本'; before = $before; after = $after }
  }
} catch {
  Send-Message @{ ok = $false; message = $_.Exception.Message }
}

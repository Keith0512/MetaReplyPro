# MetaReplyPro Native Messaging 橋接程式
# Chrome 擴充功能透過 stdio 呼叫本程式（訊息格式：4 bytes little-endian 長度 + UTF-8 JSON）。
# 收到訊息即執行同目錄的 update.ps1，並回覆結果 JSON 給擴充功能。
# 注意：stdout 只能輸出協議框架內容，任何多餘輸出都會讓 Chrome 中斷連線。
$ErrorActionPreference = 'Stop'

$stdout = [Console]::OpenStandardOutput()

function Send-Message([hashtable]$Obj) {
  $json = ConvertTo-Json $Obj -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $len = [BitConverter]::GetBytes([int]$bytes.Length)
  $stdout.Write($len, 0, 4)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

# 讀取 Chrome 送來的訊息（best-effort：訊息內容不影響行為，讀不到也照樣執行更新）
try {
  $stdin = [Console]::OpenStandardInput()
  $lenBuf = New-Object byte[] 4
  if ($stdin.Read($lenBuf, 0, 4) -eq 4) {
    $msgLen = [BitConverter]::ToInt32($lenBuf, 0)
    if ($msgLen -gt 0 -and $msgLen -lt 1MB) {
      $msgBuf = New-Object byte[] $msgLen
      $total = 0
      while ($total -lt $msgLen) {
        $n = $stdin.Read($msgBuf, $total, $msgLen - $total)
        if ($n -le 0) { break }
        $total += $n
      }
    }
  }
} catch { }

try {
  $manifestPath = Join-Path $PSScriptRoot 'chrome-extension\manifest.json'
  function Get-LocalVersion {
    if (Test-Path $manifestPath) {
      (Get-Content $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json).version
    } else { $null }
  }

  $before = Get-LocalVersion
  # 子行程執行更新；其 stdout 丟棄以免污染協議
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'update.ps1') | Out-Null
  $code = $LASTEXITCODE
  $after = Get-LocalVersion

  if ($code -eq 0) {
    Send-Message @{ ok = $true; updated = ($before -ne $after); before = $before; after = $after }
  } else {
    Send-Message @{ ok = $false; message = '更新失敗（倉庫可能未開放）'; before = $before; after = $after }
  }
} catch {
  Send-Message @{ ok = $false; message = $_.Exception.Message }
}

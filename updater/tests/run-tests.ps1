# MetaReplyPro Windows PowerShell 5.1 測試入口。
$ErrorActionPreference = 'Stop'
$tests = @(
  'test-install.ps1',
  'test-update.ps1',
  'test-setup.ps1',
  'test-native-host.ps1'
)

foreach ($test in $tests) {
  Write-Host "`n=== $test ==="
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot $test)
  if ($LASTEXITCODE -ne 0) {
    throw "$test 失敗（exit code $LASTEXITCODE）"
  }
}

Write-Host "`n所有 PowerShell 測試通過"

# MetaReplyPro 緊急緩解工具：停用舊版建立的登入／每日自動更新排程。
param(
  [string]$TaskName = 'MetaReplyPro Update'
)

$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "找不到排程工作「$TaskName」，不需要處理。"
  exit 0
}

Disable-ScheduledTask -TaskName $TaskName | Out-Null
Write-Host "已停用排程工作「$TaskName」。手動更新仍可使用，且會驗證 release 簽章與 SHA-256。"

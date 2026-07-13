# MetaReplyPro bootstrap installer, meant to be run via:
#   irm https://raw.githubusercontent.com/Keith0512/MetaReplyPro/main/updater/install.ps1 | iex
#
# This file MUST stay pure ASCII with NO BOM, NO param block and NO exit:
# Invoke-Expression cannot parse a script whose text starts with a BOM
# character, and `exit` under iex would close the user's whole console.
# It downloads setup.ps1 as raw bytes (keeping its UTF-8 BOM intact) and
# runs it with -File, which handles BOM, param blocks, Chinese text and
# exit codes correctly.
$ErrorActionPreference = 'Stop'
$setupUrl = 'https://raw.githubusercontent.com/Keith0512/MetaReplyPro/main/updater/setup.ps1'
$setupPath = Join-Path $env:TEMP 'MetaReplyPro-setup.ps1'
Invoke-WebRequest -Uri $setupUrl -OutFile $setupPath -UseBasicParsing
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $setupPath
} finally {
  Remove-Item $setupPath -Force -ErrorAction SilentlyContinue
}

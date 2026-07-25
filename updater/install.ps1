# MetaReplyPro local release installer.
# Run this file only from a release bundle verified by your administrator.
# It intentionally performs no network download and never executes GitHub main.
$ErrorActionPreference = 'Stop'
$setupPath = Join-Path $PSScriptRoot 'setup.ps1'
$sourceDir = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path -LiteralPath (Join-Path $sourceDir 'release-info.json'))) {
  throw 'This installer must be run from an extracted, verified MetaReplyPro release bundle.'
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $setupPath -SourceDir $sourceDir
if ($LASTEXITCODE -ne 0) {
  throw "MetaReplyPro setup failed with exit code $LASTEXITCODE."
}

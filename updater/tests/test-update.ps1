# update.ps1 安全更新整合測試：本機 fixture 模擬已簽章的 GitHub release。
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ("MetaReplyProSecurityTest_" + [guid]::NewGuid().ToString('N'))
$script:failed = $false
$rsa = New-Object Security.Cryptography.RSACryptoServiceProvider 2048

function Assert($condition, $name) {
  if ($condition) { Write-Host "PASS  $name" }
  else { Write-Host "FAIL  $name" -ForegroundColor Red; $script:failed = $true }
}

function Get-Sha256Hex([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function New-SignedFixture(
  [string]$Name,
  [string]$ReleaseVersion,
  [string]$PackageVersion = $ReleaseVersion,
  [string]$ReleaseCommit = '1111111111111111111111111111111111111111',
  [string]$PackageCommit = $ReleaseCommit,
  [string]$HashOverride = ''
) {
  $fixtureDir = Join-Path $root $Name
  $packageRoot = Join-Path $fixtureDir "MetaReplyPro-v$ReleaseVersion"
  $packageExtensionDir = Join-Path $packageRoot 'chrome-extension'
  $packageUpdaterDir = Join-Path $packageRoot 'updater'
  New-Item -ItemType Directory -Path $packageExtensionDir -Force | Out-Null
  New-Item -ItemType Directory -Path $packageUpdaterDir -Force | Out-Null

  (@{ version = $PackageVersion; name = 'test' } | ConvertTo-Json) |
    Set-Content (Join-Path $packageExtensionDir 'manifest.json') -Encoding utf8
  "content-$Name" | Set-Content (Join-Path $packageExtensionDir 'content.js') -Encoding utf8
  @{
    schemaVersion = 1
    version = $PackageVersion
    commit = $PackageCommit
  } | ConvertTo-Json | Set-Content (Join-Path $packageRoot 'release-info.json') -Encoding utf8

  foreach ($updaterName in @('update.ps1', 'update-host.ps1', 'update-host.bat', 'disable-auto-update.ps1')) {
    Copy-Item (Join-Path $PSScriptRoot "..\$updaterName") (Join-Path $packageUpdaterDir $updaterName)
  }
  Copy-Item $script:trustedKeyPath (Join-Path $packageUpdaterDir 'trusted-update-key.json')

  $assetName = "MetaReplyPro-v$ReleaseVersion.zip"
  $assetPath = Join-Path $fixtureDir $assetName
  Compress-Archive -Path $packageRoot -DestinationPath $assetPath
  $assetHash = if ($HashOverride) { $HashOverride } else { Get-Sha256Hex $assetPath }
  $manifest = @{
    schemaVersion = 1
    keyId = 'test-key'
    version = $ReleaseVersion
    commit = $ReleaseCommit
    assetName = $assetName
    assetUrl = $assetPath
    assetSha256 = $assetHash
    publishedAt = '2026-07-25T00:00:00.000Z'
  } | ConvertTo-Json
  $manifestPath = Join-Path $fixtureDir 'update-manifest.json'
  [IO.File]::WriteAllText($manifestPath, "$manifest`n", [Text.UTF8Encoding]::new($false))
  $manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
  $signature = $script:rsa.SignData(
    $manifestBytes,
    [Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256')
  )
  $signaturePath = "$manifestPath.sig"
  [IO.File]::WriteAllText(
    $signaturePath,
    [Convert]::ToBase64String($signature),
    [Text.Encoding]::ASCII
  )
  @{
    Manifest = $manifestPath
    Signature = $signaturePath
    Asset = $assetPath
  }
}

$updateScript = Join-Path $PSScriptRoot '..\update.ps1'
$installDir = Join-Path $root 'install'
$trustedKeyPath = Join-Path $installDir 'trusted-update-key.json'

try {
  New-Item -ItemType Directory -Path (Join-Path $installDir 'chrome-extension') -Force | Out-Null
  '{ "version": "1.0.0", "name": "test" }' |
    Set-Content (Join-Path $installDir 'chrome-extension\manifest.json') -Encoding utf8
  'old' | Set-Content (Join-Path $installDir 'chrome-extension\content.js') -Encoding utf8
  Copy-Item $updateScript (Join-Path $installDir 'update.ps1')

  $trustedKey = @{
    schemaVersion = 1
    keyId = 'test-key'
    algorithm = 'RSASSA-PKCS1-v1_5-SHA256'
    rsaKeyValue = $rsa.ToXmlString($false)
  } | ConvertTo-Json
  [IO.File]::WriteAllText($trustedKeyPath, $trustedKey, [Text.UTF8Encoding]::new($false))

  # 1. 正確簽章、hash、版本與 commit：允許更新並保留備份。
  $good = New-SignedFixture 'good' '1.1.0'
  & $updateScript -InstallDir $installDir -ManifestUrl $good.Manifest `
    -SignatureUrl $good.Signature -TrustedPublicKeyPath $trustedKeyPath -AllowLocalSources
  $newVersion = (Get-Content (Join-Path $installDir 'chrome-extension\manifest.json') -Raw | ConvertFrom-Json).version
  Assert ($LASTEXITCODE -eq 0 -and $newVersion -eq '1.1.0') '有效簽章與 SHA-256 時更新至 1.1.0'
  Assert ((Get-Content (Join-Path $installDir 'chrome-extension\content.js') -Raw).Trim() -eq 'content-good') '套用已驗證的程式檔案'
  Assert (Test-Path (Join-Path $installDir 'chrome-extension.backup\manifest.json')) '更新後保留舊版備份'

  # 2. 相同版本：驗證 manifest 後不覆蓋本機內容。
  'marker' | Set-Content (Join-Path $installDir 'chrome-extension\content.js') -Encoding utf8
  & $updateScript -InstallDir $installDir -ManifestUrl $good.Manifest `
    -SignatureUrl $good.Signature -TrustedPublicKeyPath $trustedKeyPath -AllowLocalSources
  Assert ($LASTEXITCODE -eq 0) '相同版本安全結束'
  Assert ((Get-Content (Join-Path $installDir 'chrome-extension\content.js') -Raw).Trim() -eq 'marker') '相同版本不覆蓋本機檔案'

  # 3. 錯誤簽章：拒絕更新且保留舊版。
  $badSignature = New-SignedFixture 'bad-signature' '1.2.0'
  [IO.File]::WriteAllText(
    $badSignature.Signature,
    [Convert]::ToBase64String((New-Object byte[] 256)),
    [Text.Encoding]::ASCII
  )
  & $updateScript -InstallDir $installDir -ManifestUrl $badSignature.Manifest `
    -SignatureUrl $badSignature.Signature -TrustedPublicKeyPath $trustedKeyPath -AllowLocalSources
  Assert ($LASTEXITCODE -ne 0) 'release manifest 簽章錯誤時拒絕更新'
  Assert ((Get-Content (Join-Path $installDir 'chrome-extension\content.js') -Raw).Trim() -eq 'marker') '簽章錯誤時保留舊版'

  # 4. ZIP hash 不符：簽章正確仍拒絕更新。
  $badHash = New-SignedFixture 'bad-hash' '1.2.0' -HashOverride ('0' * 64)
  & $updateScript -InstallDir $installDir -ManifestUrl $badHash.Manifest `
    -SignatureUrl $badHash.Signature -TrustedPublicKeyPath $trustedKeyPath -AllowLocalSources
  Assert ($LASTEXITCODE -ne 0) 'release ZIP 的 SHA-256 不符時拒絕更新'
  Assert ((Get-Content (Join-Path $installDir 'chrome-extension\content.js') -Raw).Trim() -eq 'marker') 'hash 錯誤時保留舊版'

  # 5. ZIP 內容與簽章 manifest 的版本不一致：拒絕更新。
  $badVersion = New-SignedFixture 'bad-version' '1.2.0' '9.9.9'
  & $updateScript -InstallDir $installDir -ManifestUrl $badVersion.Manifest `
    -SignatureUrl $badVersion.Signature -TrustedPublicKeyPath $trustedKeyPath -AllowLocalSources
  Assert ($LASTEXITCODE -ne 0) 'ZIP 版本與 release manifest 不一致時拒絕更新'

  # 6. ZIP 內 commit 與簽章 manifest 不一致：拒絕更新。
  $badCommit = New-SignedFixture 'bad-commit' '1.2.0' '1.2.0' `
    '2222222222222222222222222222222222222222' `
    '3333333333333333333333333333333333333333'
  & $updateScript -InstallDir $installDir -ManifestUrl $badCommit.Manifest `
    -SignatureUrl $badCommit.Signature -TrustedPublicKeyPath $trustedKeyPath -AllowLocalSources
  Assert ($LASTEXITCODE -ne 0) 'ZIP commit 與 release manifest 不一致時拒絕更新'

  Assert (Test-Path (Join-Path $installDir 'update.log')) '安全檢查結果寫入 update.log'
} finally {
  $rsa.Dispose()
  if (Test-Path $root) { Remove-Item $root -Recurse -Force }
}

if ($script:failed) { Write-Host "`n有測試失敗" -ForegroundColor Red; exit 1 }
else { Write-Host "`n全部通過"; exit 0 }

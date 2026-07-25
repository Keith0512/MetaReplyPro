# MetaReplyPro 安全更新程式
# 只接受由固定公開金鑰驗證成功的 release manifest，並在替換前核對 ZIP 的 SHA-256。
param(
  [string]$InstallDir = "$env:LOCALAPPDATA\MetaReplyPro",
  [string]$ManifestUrl = 'https://github.com/Keith0512/MetaReplyPro/releases/latest/download/update-manifest.json',
  [string]$SignatureUrl = 'https://github.com/Keith0512/MetaReplyPro/releases/latest/download/update-manifest.json.sig',
  [string]$TrustedPublicKeyPath = '',
  [switch]$Interactive,
  [switch]$AllowLocalSources
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Wait-IfInteractive {
  if ($Interactive) { Write-Host ''; Read-Host '按 Enter 關閉視窗' | Out-Null }
}

if (-not (Test-Path -LiteralPath $InstallDir)) {
  Write-Host "找不到安裝目錄 $InstallDir，請先從可信任的 release 安裝 MetaReplyPro"
  Wait-IfInteractive
  exit 1
}

if (-not $TrustedPublicKeyPath) {
  $TrustedPublicKeyPath = Join-Path $InstallDir 'trusted-update-key.json'
}

$logFile = Join-Path $InstallDir 'update.log'
function Write-Log([string]$Message) {
  Add-Content -LiteralPath $logFile -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $Message) -Encoding utf8
  if ($Interactive) { Write-Host $Message }
}

function Assert-ReleaseUrl([string]$Url, [string]$Name) {
  try {
    $uri = New-Object System.Uri($Url)
  } catch {
    throw "$Name 不是有效網址"
  }
  if ($uri.Scheme -ne 'https') {
    throw "$Name 必須使用 HTTPS"
  }
  if ($uri.Host -ne 'github.com') {
    throw "$Name 只允許 github.com"
  }
  $allowedPath = '^/Keith0512/MetaReplyPro/releases/(latest/download|download/[^/]+)/[^/]+$'
  if ($uri.AbsolutePath -notmatch $allowedPath) {
    throw "$Name 必須指向 Keith0512/MetaReplyPro 的 release asset"
  }
}

function Get-TrustedFile([string]$Source, [string]$Destination, [string]$Name) {
  if ($Source -match '^https://') {
    Assert-ReleaseUrl $Source $Name
    Invoke-WebRequest -Uri $Source -OutFile $Destination -UseBasicParsing
    return
  }
  if (-not $AllowLocalSources) {
    throw "$Name 拒絕非 HTTPS 來源"
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Get-Sha256Hex([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Read-And-VerifyReleaseManifest(
  [string]$ManifestPath,
  [string]$ManifestSignaturePath,
  [string]$PublicKeyPath
) {
  if (-not (Test-Path -LiteralPath $PublicKeyPath)) {
    throw "找不到受信任的更新公開金鑰：$PublicKeyPath"
  }

  $trustedKey = Get-Content -LiteralPath $PublicKeyPath -Raw -Encoding utf8 | ConvertFrom-Json
  if (
    [int]$trustedKey.schemaVersion -ne 1 -or
    [string]$trustedKey.algorithm -ne 'RSASSA-PKCS1-v1_5-SHA256' -or
    [string]::IsNullOrWhiteSpace([string]$trustedKey.keyId) -or
    [string]::IsNullOrWhiteSpace([string]$trustedKey.rsaKeyValue)
  ) {
    throw '受信任的更新公開金鑰格式無效'
  }

  $manifestBytes = [IO.File]::ReadAllBytes($ManifestPath)
  try {
    $signatureText = (Get-Content -LiteralPath $ManifestSignaturePath -Raw -Encoding ascii).Trim()
    $signatureBytes = [Convert]::FromBase64String($signatureText)
  } catch {
    throw 'release manifest 簽章不是有效的 Base64'
  }

  $rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
  try {
    $rsa.PersistKeyInCsp = $false
    $rsa.FromXmlString([string]$trustedKey.rsaKeyValue)
    $sha256Oid = [Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256')
    if (-not $rsa.VerifyData($manifestBytes, $sha256Oid, $signatureBytes)) {
      throw 'release manifest 簽章驗證失敗'
    }
  } finally {
    $rsa.Dispose()
  }

  $release = [Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
  if ([int]$release.schemaVersion -ne 1) {
    throw '不支援的 release manifest 格式'
  }
  if ([string]$release.keyId -ne [string]$trustedKey.keyId) {
    throw 'release manifest 的簽章金鑰識別碼不符'
  }
  if ([string]$release.commit -notmatch '^[0-9a-f]{40}$') {
    throw 'release manifest 的 commit SHA 無效'
  }
  if ([string]$release.assetSha256 -notmatch '^[0-9a-f]{64}$') {
    throw 'release manifest 的 SHA-256 無效'
  }
  if ([string]::IsNullOrWhiteSpace([string]$release.assetName)) {
    throw 'release manifest 缺少 assetName'
  }
  if ([string]::IsNullOrWhiteSpace([string]$release.assetUrl)) {
    throw 'release manifest 缺少 assetUrl'
  }
  try {
    [void][version]([string]$release.version)
  } catch {
    throw 'release manifest 的版本號無效'
  }

  if ([string]$release.assetUrl -match '^https://') {
    Assert-ReleaseUrl ([string]$release.assetUrl) 'release asset'
    $assetFileName = [IO.Path]::GetFileName((New-Object System.Uri([string]$release.assetUrl)).AbsolutePath)
  } elseif ($AllowLocalSources) {
    $assetFileName = [IO.Path]::GetFileName([string]$release.assetUrl)
  } else {
    throw 'release asset 拒絕非 HTTPS 來源'
  }
  if ($assetFileName -ne [string]$release.assetName) {
    throw 'release manifest 的 assetName 與 assetUrl 不一致'
  }

  return @{
    Release = $release
    TrustedKey = $trustedKey
  }
}

$extensionDir = Join-Path $InstallDir 'chrome-extension'
$backupDir = Join-Path $InstallDir 'chrome-extension.backup'
$tempDir = Join-Path $env:TEMP ("MetaReplyProUpdate_" + [guid]::NewGuid().ToString('N'))

if ($Interactive) { Write-Host '正在驗證 MetaReplyPro 安全更新…' }

try {
  if (-not (Test-Path -LiteralPath (Join-Path $extensionDir 'manifest.json'))) {
    throw '本機擴充功能缺少 manifest.json，請重新安裝'
  }
  New-Item -ItemType Directory -Path $tempDir | Out-Null

  $remoteManifestPath = Join-Path $tempDir 'update-manifest.json'
  $remoteSignaturePath = Join-Path $tempDir 'update-manifest.json.sig'
  Get-TrustedFile $ManifestUrl $remoteManifestPath 'release manifest'
  Get-TrustedFile $SignatureUrl $remoteSignaturePath 'release manifest 簽章'
  $verified = Read-And-VerifyReleaseManifest $remoteManifestPath $remoteSignaturePath $TrustedPublicKeyPath
  $release = $verified.Release
  $trustedKey = $verified.TrustedKey

  $localVersion = [version](Get-Content -LiteralPath (Join-Path $extensionDir 'manifest.json') -Raw -Encoding utf8 | ConvertFrom-Json).version
  $remoteVersion = [version]([string]$release.version)
  if ($remoteVersion -le $localVersion) {
    Write-Log "已是最新版 $localVersion（已驗證 release $remoteVersion），不需更新"
    Wait-IfInteractive
    exit 0
  }

  Write-Log "已驗證新版 manifest $remoteVersion（本機 $localVersion），開始下載固定 release"
  $zipPath = Join-Path $tempDir ([string]$release.assetName)
  Get-TrustedFile ([string]$release.assetUrl) $zipPath 'release asset'
  $actualSha256 = Get-Sha256Hex $zipPath
  if ($actualSha256 -ne ([string]$release.assetSha256).ToLowerInvariant()) {
    throw "release asset SHA-256 不符（預期 $($release.assetSha256)，實際 $actualSha256）"
  }

  $extractDir = Join-Path $tempDir 'extracted'
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir
  $rootDirectories = @(Get-ChildItem -LiteralPath $extractDir -Directory)
  $rootFiles = @(Get-ChildItem -LiteralPath $extractDir -File)
  if ($rootDirectories.Count -ne 1 -or $rootFiles.Count -ne 0) {
    throw 'release ZIP 必須只有一個頂層資料夾'
  }
  $packageRoot = $rootDirectories[0].FullName
  $releaseInfoPath = Join-Path $packageRoot 'release-info.json'
  $newExtensionDir = Join-Path $packageRoot 'chrome-extension'
  $newUpdaterDir = Join-Path $packageRoot 'updater'
  if (-not (Test-Path -LiteralPath $releaseInfoPath)) {
    throw 'release ZIP 缺少 release-info.json'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $newExtensionDir 'manifest.json'))) {
    throw 'release ZIP 缺少 chrome-extension\manifest.json'
  }

  $releaseInfo = Get-Content -LiteralPath $releaseInfoPath -Raw -Encoding utf8 | ConvertFrom-Json
  $newExtensionManifest = Get-Content -LiteralPath (Join-Path $newExtensionDir 'manifest.json') -Raw -Encoding utf8 | ConvertFrom-Json
  if (
    [int]$releaseInfo.schemaVersion -ne 1 -or
    [string]$releaseInfo.version -ne [string]$release.version -or
    [string]$releaseInfo.commit -ne [string]$release.commit
  ) {
    throw 'release-info.json 與已簽章的 release manifest 不一致'
  }
  if ([string]$newExtensionManifest.version -ne [string]$release.version) {
    throw 'ZIP 內擴充功能版本與已簽章的 release manifest 不一致'
  }

  $updaterFiles = @(
    'update.ps1',
    'update-host.ps1',
    'update-host.bat',
    'disable-auto-update.ps1',
    'trusted-update-key.json'
  )
  foreach ($name in $updaterFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $newUpdaterDir $name))) {
      throw "release ZIP 缺少 updater\$name"
    }
  }
  $packagedKey = Get-Content -LiteralPath (Join-Path $newUpdaterDir 'trusted-update-key.json') -Raw -Encoding utf8 | ConvertFrom-Json
  if (
    [int]$packagedKey.schemaVersion -ne [int]$trustedKey.schemaVersion -or
    [string]$packagedKey.keyId -ne [string]$trustedKey.keyId -or
    [string]$packagedKey.algorithm -ne [string]$trustedKey.algorithm -or
    [string]$packagedKey.rsaKeyValue -ne [string]$trustedKey.rsaKeyValue
  ) {
    throw 'release ZIP 嘗試未經核准地更換更新信任金鑰'
  }

  $updaterBackupDir = Join-Path $tempDir 'updater-backup'
  New-Item -ItemType Directory -Path $updaterBackupDir | Out-Null
  $existingUpdaterFiles = @()
  foreach ($name in $updaterFiles) {
    $destination = Join-Path $InstallDir $name
    if (Test-Path -LiteralPath $destination) {
      Copy-Item -LiteralPath $destination -Destination (Join-Path $updaterBackupDir $name) -Force
      $existingUpdaterFiles += $name
    }
  }

  if (Test-Path -LiteralPath $backupDir) {
    Remove-Item -LiteralPath $backupDir -Recurse -Force
  }
  Move-Item -LiteralPath $extensionDir -Destination $backupDir
  try {
    Copy-Item -LiteralPath $newExtensionDir -Destination $extensionDir -Recurse
    foreach ($name in $updaterFiles) {
      Copy-Item -LiteralPath (Join-Path $newUpdaterDir $name) -Destination (Join-Path $InstallDir $name) -Force
    }
  } catch {
    if (Test-Path -LiteralPath $extensionDir) {
      Remove-Item -LiteralPath $extensionDir -Recurse -Force
    }
    if (Test-Path -LiteralPath $backupDir) {
      Move-Item -LiteralPath $backupDir -Destination $extensionDir
    }
    foreach ($name in $updaterFiles) {
      $destination = Join-Path $InstallDir $name
      if ($existingUpdaterFiles -contains $name) {
        Copy-Item -LiteralPath (Join-Path $updaterBackupDir $name) -Destination $destination -Force
      } elseif (Test-Path -LiteralPath $destination) {
        Remove-Item -LiteralPath $destination -Force
      }
    }
    throw
  }

  Write-Log "安全更新完成：$localVersion → $remoteVersion（commit $($release.commit)）"
  if ($Interactive) { Write-Host '擴充功能會在幾分鐘內自動重新載入，不需要手動操作。' }
  Wait-IfInteractive
  exit 0
} catch {
  Write-Log "更新失敗並已拒絕套用：$($_.Exception.Message)"
  Wait-IfInteractive
  exit 1
} finally {
  if (Test-Path -LiteralPath $tempDir) {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# Run the official v1.5.3-to-v1.5.4 reinstall in a disposable Windows user.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.ToString() -notmatch '^5\.1\.') {
  throw 'This smoke test requires Windows PowerShell 5.1 Desktop.'
}
if (-not $env:RUNNER_TEMP) { throw 'RUNNER_TEMP must point to an isolated Windows runner.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$testRoot = Join-Path $env:RUNNER_TEMP 'MetaReplyPro-Windows154'
$installDir = Join-Path $env:LOCALAPPDATA 'MetaReplyPro'
$releaseBase = 'https://github.com/Keith0512/MetaReplyPro/releases/download'
$legacyHost = 'com.metareplypro.updater'
$pinnedHost = 'com.metareplypro.updater.pinned'
$origin = 'chrome-extension://gnekicgafkpbmafejjcbaagcpfnmfjbh/'

function Receive-File([string]$Url, [string]$Destination) {
  & curl.exe --silent --show-error --fail --location --retry 2 --output $Destination $Url
  if ($LASTEXITCODE -ne 0) { throw "Download failed ($LASTEXITCODE): $Url" }
}

function Read-Json([string]$Path) {
  Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json
}

function Receive-Release([string]$Version, [string]$ExpectedCommit) {
  $directory = Join-Path $testRoot "v$Version"
  New-Item -ItemType Directory -Path $directory | Out-Null
  $zipName = "MetaReplyPro-v$Version.zip"
  $manifestPath = Join-Path $directory 'update-manifest.json'
  foreach ($file in @('update-manifest.json', 'update-manifest.json.sig', $zipName)) {
    Receive-File "$releaseBase/v$Version/$file" (Join-Path $directory $file)
  }

  $verifier = Join-Path $repoRoot 'updater\release\verify-release.mjs'
  $publicKey = Join-Path $repoRoot 'updater\trusted-update-key.json'
  & node $verifier --manifest $manifestPath --public-key $publicKey | Write-Host
  if ($LASTEXITCODE -ne 0) { throw "Signature or ZIP hash verification failed for v$Version." }
  $manifest = Read-Json $manifestPath
  if ($manifest.version -cne $Version -or $manifest.commit -cne $ExpectedCommit -or
      $manifest.assetName -cne $zipName -or $manifest.assetUrl -cne "$releaseBase/v$Version/$zipName") {
    throw "The signed v$Version manifest does not match the expected release."
  }

  Expand-Archive -LiteralPath (Join-Path $directory $zipName) -DestinationPath $directory
  $package = Join-Path $directory "MetaReplyPro-v$Version"
  $releaseInfo = Read-Json (Join-Path $package 'release-info.json')
  $extension = Read-Json (Join-Path $package 'chrome-extension\manifest.json')
  if ($releaseInfo.schemaVersion -ne 1 -or $releaseInfo.version -cne $Version -or
      $releaseInfo.commit -cne $ExpectedCommit -or $extension.version -cne $Version) {
    throw "The signed v$Version package contains unexpected version or commit information."
  }

  @{
    package = $package
    commit = $ExpectedCommit
    version = $Version
    manifestSha = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

function Get-ChromeHostManifestPath([string]$HostName) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
    $userKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
    try {
      $key = $userKey.OpenSubKey("Software\Google\Chrome\NativeMessagingHosts\$HostName")
      if ($null -ne $key) {
        try {
          $path = $key.GetValue('')
          if ($path) { return $path }
        } finally {
          $key.Dispose()
        }
      }
    } finally {
      $userKey.Dispose()
    }
  }
}

function Install-Release($Release, [string]$HostName, [string[]]$HostFiles) {
  $installer = Join-Path $Release.package 'updater\install.ps1'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
  if ($LASTEXITCODE -ne 0) { throw "Official $($Release.version) installer failed ($LASTEXITCODE)." }

  $extension = Read-Json (Join-Path $installDir 'chrome-extension\manifest.json')
  $installedRelease = Read-Json (Join-Path $installDir 'release-info.json')
  if ($extension.version -cne $Release.version -or $installedRelease.version -cne $Release.version -or
      $installedRelease.commit -cne $Release.commit) {
    throw "Installed version or commit does not match v$($Release.version)."
  }

  $manifestPath = Get-ChromeHostManifestPath $HostName
  if ($manifestPath -ne (Join-Path $installDir "$HostName.json")) {
    throw "Unexpected Chrome registry value for ${HostName}: $manifestPath"
  }
  $hostManifest = Read-Json $manifestPath
  if ($hostManifest.name -cne $HostName -or $hostManifest.type -cne 'stdio' -or
      $hostManifest.path -ne (Join-Path $installDir $HostFiles[0]) -or
      @($hostManifest.allowed_origins).Count -ne 1 -or $hostManifest.allowed_origins[0] -cne $origin) {
    throw "Unexpected native messaging manifest for $HostName."
  }
  $updaterDir = Join-Path $Release.package 'updater'
  foreach ($file in $HostFiles) {
    $packaged = (Get-FileHash -LiteralPath (Join-Path $updaterDir $file) -Algorithm SHA256).Hash
    $installed = (Get-FileHash -LiteralPath (Join-Path $installDir $file) -Algorithm SHA256).Hash
    if ($installed -cne $packaged) { throw "Installed $file does not match the signed package." }
  }
  Write-Host "PASS Installed v$($Release.version) with $HostName at $($hostManifest.path)"
}

if ((Test-Path -LiteralPath $installDir) -or (Get-ChromeHostManifestPath $legacyHost) -or
    (Get-ChromeHostManifestPath $pinnedHost)) {
  throw 'Use a disposable Windows user without a prior MetaReplyPro installation.'
}
New-Item -ItemType Directory -Path $testRoot | Out-Null
Write-Host "Windows PowerShell $($PSVersionTable.PSVersion) $($PSVersionTable.PSEdition)"

Push-Location -LiteralPath $repoRoot
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'run-tests.ps1')
  if ($LASTEXITCODE -ne 0) { throw "Windows PowerShell suite failed ($LASTEXITCODE)." }

  $old = Receive-Release '1.5.3' '791defcf745f34117757ec8b23fd89afdc6811f8'
  $new = Receive-Release '1.5.4' 'ee55d3d470053c5bdd6ea75026f49147c1473197'

  $chromeIndex = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
  $stable = (Invoke-RestMethod -Uri $chromeIndex -UseBasicParsing).channels.Stable
  $chromeDownload = $stable.downloads.chrome | Where-Object { $_.platform -eq 'win64' } | Select-Object -First 1
  if ($chromeDownload.url -cnotmatch '^https://storage\.googleapis\.com/chrome-for-testing-public/[0-9.]+/win64/chrome-win64\.zip$') {
    throw 'Official Windows x64 Chrome for Testing download URL was unavailable.'
  }
  $chromeZip = Join-Path $testRoot 'chrome-win64.zip'
  Receive-File $chromeDownload.url $chromeZip
  Expand-Archive -LiteralPath $chromeZip -DestinationPath $testRoot
  $env:METAREPLY_TEST_CHROME = Join-Path $testRoot 'chrome-win64\chrome.exe'
  if (-not (Test-Path -LiteralPath $env:METAREPLY_TEST_CHROME -PathType Leaf)) {
    throw 'Chrome for Testing executable was missing from the Windows x64 package.'
  }
  $env:METAREPLY_TEST_ROOT = $testRoot
  $env:METAREPLY_TEST_MANIFEST_SHA = $new.manifestSha
  Write-Host "Chrome for Testing stable $($stable.version), win64"

  Install-Release $old $legacyHost @('update-host.bat', 'update-host.ps1', 'update.ps1')
  if (Get-ChromeHostManifestPath $pinnedHost) { throw 'The old installer unexpectedly registered the new host.' }
  & node tests/windows-v154-chrome.mjs before
  if ($LASTEXITCODE -ne 0) { throw "Pre-reinstall Chrome check failed ($LASTEXITCODE)." }

  Install-Release $new $pinnedHost @('update-host-pinned.bat', 'update-host-pinned.ps1', 'update-pinned.ps1')
  & node tests/windows-v154-chrome.mjs after
  if ($LASTEXITCODE -ne 0) { throw "Post-reinstall Chrome check failed ($LASTEXITCODE)." }
  Write-Host 'PASS Windows PowerShell and Chrome smoke test'
} finally {
  Pop-Location
}

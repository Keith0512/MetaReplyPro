# Run the v1.5.4-to-v1.5.5 reinstall in a disposable Windows runner.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.ToString() -notmatch '^5\.1\.') {
  throw 'This smoke test requires Windows PowerShell 5.1 Desktop.'
}
if (-not $env:RUNNER_TEMP) { throw 'RUNNER_TEMP must point to an isolated Windows runner.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$mode = $env:METAREPLY_TEST_MODE
$candidateCommit = $env:METAREPLY_TEST_CANDIDATE_COMMIT
if ($mode -cnotin @('staging', 'published') -or $candidateCommit -cnotmatch '^[0-9a-f]{40}$') {
  throw 'Set METAREPLY_TEST_MODE to staging or published and METAREPLY_TEST_CANDIDATE_COMMIT to the exact v1.5.5 commit.'
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$testRoot = Join-Path $env:RUNNER_TEMP 'MetaReplyPro-Windows155'
$installDir = Join-Path $env:LOCALAPPDATA 'MetaReplyPro'
$releaseBase = 'https://github.com/Keith0512/MetaReplyPro/releases/download'
$releaseApi = 'https://api.github.com/repos/Keith0512/MetaReplyPro/releases'
$baselineCommit = 'ee55d3d470053c5bdd6ea75026f49147c1473197'
$legacyHost = 'com.metareplypro.updater'
$pinnedHost = 'com.metareplypro.updater.pinned'
$pinnedFiles = @('update-host-pinned.bat', 'update-host-pinned.ps1', 'update-pinned.ps1')
$origin = 'chrome-extension://gnekicgafkpbmafejjcbaagcpfnmfjbh/'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MetaReplyPro Update.lnk'
$legacyShortcut = 'MetaReplyPro ' + [char]0x66F4 + [char]0x65B0 + '.lnk'
$legacyShortcutFailure = 'Unable to save shortcut "[^"\r\n]*\\(?:MetaReplyPro \?\?\.lnk|' + [regex]::Escape($legacyShortcut) + ')"'

function Invoke-DesktopPowerShell([string]$ScriptPath, [string]$Arguments = '') {
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = Join-Path $PSHOME 'powershell.exe'
  $start.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" {1}' -f $ScriptPath, $Arguments
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = [Diagnostics.Process]::Start($start)
  try {
    $outputTask = $process.StandardOutput.ReadToEndAsync()
    $errorTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $output = $outputTask.GetAwaiter().GetResult()
    $errors = $errorTask.GetAwaiter().GetResult()
    if ($output) { Write-Host $output.TrimEnd() }
    if ($errors) { Write-Host $errors.TrimEnd() }
    @{ code = $process.ExitCode; output = $output; errors = $errors }
  } finally {
    $process.Dispose()
  }
}

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
    label = "Official v$Version"
    package = $package
    commit = $ExpectedCommit
    version = $Version
    manifestSha = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

function New-StagedCandidate($Baseline) {
  # Only files shipped by the release build need overlaying. Test files are not shipped.
  $overlay = @('chrome-extension/manifest.json', 'updater/setup.ps1')
  $changed = @(& git diff --name-only $baselineCommit $candidateCommit -- chrome-extension updater)
  if ($LASTEXITCODE -ne 0) { throw 'Could not compare the original and candidate commits.' }
  $packageChanges = @($changed | Where-Object { $_ -notlike 'updater/tests/*' })
  if ($packageChanges.Count -ne $overlay.Count -or (Compare-Object -ReferenceObject $overlay -DifferenceObject $packageChanges)) {
    throw "Staging overlay does not match candidate package changes: $($packageChanges -join ', ')."
  }

  $package = Join-Path $testRoot 'staging\MetaReplyPro-v1.5.5'
  New-Item -ItemType Directory -Path (Split-Path -Parent $package) | Out-Null
  Copy-Item -LiteralPath $Baseline.package -Destination $package -Recurse
  $overlayZip = Join-Path $testRoot 'candidate-overlay.zip'
  & git archive --format=zip "--output=$overlayZip" $candidateCommit -- @overlay
  if ($LASTEXITCODE -ne 0) { throw 'Could not extract the exact candidate files from Git.' }
  Expand-Archive -LiteralPath $overlayZip -DestinationPath $package -Force
  $version = (Read-Json (Join-Path $package 'chrome-extension\manifest.json')).version
  if ($version -cne '1.5.5') { throw "Unexpected staged candidate version: $version" }
  $releaseInfo = @{ schemaVersion = 1; version = $version; commit = $candidateCommit } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $package 'release-info.json'), $releaseInfo, [Text.UTF8Encoding]::new($false))
  Write-Host "Staged v1.5.5 from verified v1.5.4 and candidate Git commit $candidateCommit. The staged tree is not a signed published release."
  @{
    label = 'Staged v1.5.5'
    package = $package
    commit = $candidateCommit
    version = $version
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

function Install-Release($Release, [switch]$AllowBaselineShortcutRetry) {
  $installer = Join-Path $Release.package 'updater\install.ps1'
  $defaultInstall = Invoke-DesktopPowerShell $installer
  Write-Host "$($Release.label) default installer exit code: $($defaultInstall.code)"
  if ($defaultInstall.code -ne 0) {
    $failureOutput = $defaultInstall.output + $defaultInstall.errors
    if (-not $AllowBaselineShortcutRetry -or $Release.version -cne '1.5.4' -or
        $defaultInstall.code -ne 1 -or $failureOutput -notmatch $legacyShortcutFailure -or
        $failureOutput -notmatch 'MetaReplyPro setup failed with exit code 1') {
      throw "$($Release.label) default installer failed ($($defaultInstall.code))."
    }
    Write-Warning 'Official v1.5.4 reproduced its known shortcut failure. Retrying the baseline setup with -SkipDesktopShortcut.'
    $setup = Join-Path $Release.package 'updater\setup.ps1'
    $setupArguments = '-SourceDir "{0}" -SkipDesktopShortcut' -f $Release.package
    $retry = Invoke-DesktopPowerShell $setup $setupArguments
    if ($retry.code -ne 0) { throw "Official v$($Release.version) setup retry failed ($($retry.code))." }
  }

  $extension = Read-Json (Join-Path $installDir 'chrome-extension\manifest.json')
  $installedRelease = Read-Json (Join-Path $installDir 'release-info.json')
  if ($extension.version -cne $Release.version -or $installedRelease.version -cne $Release.version -or
      $installedRelease.commit -cne $Release.commit) {
    throw "Installed version or commit does not match v$($Release.version)."
  }

  $manifestPath = Get-ChromeHostManifestPath $pinnedHost
  if ($manifestPath -ne (Join-Path $installDir "$pinnedHost.json")) {
    throw "Unexpected Chrome registry value for ${pinnedHost}: $manifestPath"
  }
  $hostManifest = Read-Json $manifestPath
  if ($hostManifest.name -cne $pinnedHost -or $hostManifest.type -cne 'stdio' -or
      $hostManifest.path -ne (Join-Path $installDir $pinnedFiles[0]) -or
      @($hostManifest.allowed_origins).Count -ne 1 -or $hostManifest.allowed_origins[0] -cne $origin) {
    throw "Unexpected native messaging manifest for $pinnedHost."
  }
  $updaterDir = Join-Path $Release.package 'updater'
  foreach ($file in $pinnedFiles) {
    $packaged = (Get-FileHash -LiteralPath (Join-Path $updaterDir $file) -Algorithm SHA256).Hash
    $installed = (Get-FileHash -LiteralPath (Join-Path $installDir $file) -Algorithm SHA256).Hash
    if ($installed -cne $packaged) { throw "Installed $file does not match the selected package." }
  }
  Write-Host "PASS Installed v$($Release.version) with $pinnedHost at $($hostManifest.path)"
}

function Assert-DesktopShortcut {
  if (-not (Test-Path -LiteralPath $desktopShortcut -PathType Leaf)) {
    throw "The default v1.5.5 install did not create $desktopShortcut."
  }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($desktopShortcut)
  $target = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $expectedArguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Interactive' -f (Join-Path $installDir 'update.ps1')
  if ($shortcut.TargetPath -ne $target -or -not (Test-Path -LiteralPath $shortcut.TargetPath -PathType Leaf) -or
      $shortcut.Arguments -cne $expectedArguments -or $shortcut.WorkingDirectory -ne $installDir) {
    throw "Unexpected shortcut settings: target=$($shortcut.TargetPath); args=$($shortcut.Arguments); working directory=$($shortcut.WorkingDirectory)"
  }
  Write-Host "PASS Desktop shortcut $desktopShortcut points to the installed updater."
}

if ((Test-Path -LiteralPath $installDir) -or (Test-Path -LiteralPath $desktopShortcut) -or
    (Get-ChromeHostManifestPath $legacyHost) -or (Get-ChromeHostManifestPath $pinnedHost)) {
  throw 'Use a disposable Windows user without a prior MetaReplyPro installation.'
}
New-Item -ItemType Directory -Path $testRoot | Out-Null
Write-Host "Windows PowerShell $($PSVersionTable.PSVersion) $($PSVersionTable.PSEdition)"
Write-Host "Windows system locale: $((Get-WinSystemLocale).Name); ANSI code page: $([Text.Encoding]::Default.CodePage); console code page: $([Console]::OutputEncoding.CodePage)"
Write-Host "Verification mode: $mode; candidate commit: $candidateCommit"

Push-Location -LiteralPath $repoRoot
try {
  & git merge-base --is-ancestor $candidateCommit HEAD
  if ($LASTEXITCODE -ne 0) { throw 'The Windows test checkout must contain the candidate commit.' }
  & git diff --quiet $candidateCommit -- chrome-extension updater/release updater/setup.ps1 updater/tests/test-setup.ps1 updater/tests/test-native-host.ps1
  if ($LASTEXITCODE -ne 0) { throw 'The Windows test checkout has different candidate runtime files or regression tests.' }

  $suite = Invoke-DesktopPowerShell (Join-Path $PSScriptRoot 'run-tests.ps1')
  if ($suite.code -ne 0) { throw "Windows PowerShell suite failed ($($suite.code))." }

  $old = Receive-Release '1.5.4' $baselineCommit
  if ($mode -ceq 'staging') {
    $new = New-StagedCandidate $old
    $publicLatest = $old
  } else {
    $new = Receive-Release '1.5.5' $candidateCommit
    $publicLatest = $new
  }
  $listedLatest = Invoke-RestMethod -Uri "$releaseApi/latest" -UseBasicParsing
  if ($listedLatest.tag_name -cne "v$($publicLatest.version)") {
    throw "Unexpected live latest tag: $($listedLatest.tag_name). Expected v$($publicLatest.version) in $mode mode."
  }

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
  $env:METAREPLY_TEST_PUBLIC_LATEST = $publicLatest.version
  $env:METAREPLY_TEST_MANIFEST_SHA = $publicLatest.manifestSha
  Write-Host "Chrome for Testing stable $($stable.version), win64"

  Install-Release $old -AllowBaselineShortcutRetry
  & node tests/windows-v155-chrome.mjs before
  if ($LASTEXITCODE -ne 0) { throw "Pre-reinstall Chrome check failed ($LASTEXITCODE)." }

  Install-Release $new
  Assert-DesktopShortcut
  & node tests/windows-v155-chrome.mjs after
  if ($LASTEXITCODE -ne 0) { throw "Post-reinstall Chrome check failed ($LASTEXITCODE)." }
  Write-Host "PASS $($new.label) default Windows PowerShell install, desktop shortcut and Chrome smoke test"
} finally {
  Pop-Location
}

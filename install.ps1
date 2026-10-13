param([switch]$RegisterWindowsStartup)
$ErrorActionPreference = 'Stop'
$sourceRoot = $PSScriptRoot
$relayState = Join-Path $env:USERPROFILE '.codex-account-relay'
$previousState = Join-Path $env:LOCALAPPDATA 'CodexAccountRelay'
$appRoot = Join-Path $relayState 'app'
$appExe = Join-Path $appRoot 'CodexAccountRelay.exe'
$nodeExe = (Get-Command node.exe).Source
$authFile = Join-Path $env:USERPROFILE '.codex\auth.json'
$authBefore = (Get-FileHash -LiteralPath $authFile -Algorithm SHA256).Hash
. (Join-Path $sourceRoot 'scripts\update-safety.ps1')
if (-not (Test-Path -LiteralPath (Join-Path $relayState 'business.dpapi')) -and -not (Test-Path -LiteralPath (Join-Path $previousState 'business.dpapi'))) { throw 'Register Business with node src/cli.mjs login-business first.' }
& (Join-Path $sourceRoot 'build.ps1')
& $nodeExe --input-type=module -e "import {pathToFileURL} from 'node:url'; const m=await import(pathToFileURL(process.argv[1])); await m.privateDirectory(m.stateHome);" (Join-Path $sourceRoot 'src\credentials.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Cannot initialize the private application folder.' }
# Stop the prior AppData-based build before migrating its encrypted credentials.
$previousExe = Join-Path $previousState 'app\CodexAccountRelay.exe'
$previousRunning = @(Get-CimInstance Win32_Process -Filter "Name = 'CodexAccountRelay.exe'" | Where-Object { $_.ExecutablePath -eq $previousExe -or $_.ExecutablePath -like '*\LocalCache\Local\CodexAccountRelay\app\CodexAccountRelay.exe' })
if ($previousRunning.Count -gt 0) {
    Assert-RelayIdle (Join-Path $previousState 'manager-status.json')
    $savedRelayHome = $env:CODEX_RELAY_HOME
    try { $env:CODEX_RELAY_HOME = $previousState; & $nodeExe (Join-Path $sourceRoot 'src\control.mjs') quit }
    finally { $env:CODEX_RELAY_HOME = $savedRelayHome }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 500
        $previousRunning = @(Get-CimInstance Win32_Process -Filter "Name = 'CodexAccountRelay.exe'" | Where-Object { $_.ExecutablePath -eq $previousExe -or $_.ExecutablePath -like '*\LocalCache\Local\CodexAccountRelay\app\CodexAccountRelay.exe' })
    } while ($previousRunning.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($previousRunning.Count -gt 0) { throw 'Close the previous relay before migrating.' }
}
if (-not (Test-Path -LiteralPath (Join-Path $relayState 'business.dpapi'))) {
    foreach ($file in @('business.dpapi', 'quota.json', 'settings.json')) {
        $oldFile = Join-Path $previousState $file
        if (Test-Path -LiteralPath $oldFile) { Copy-Item -LiteralPath $oldFile -Destination (Join-Path $relayState $file) }
    }
}
$running = @(Get-CimInstance Win32_Process -Filter "Name = 'CodexAccountRelay.exe'" | Where-Object { $_.ExecutablePath -eq $appExe })
if ($running.Count -gt 0) {
    Assert-RelayIdle (Join-Path $relayState 'manager-status.json')
    & $nodeExe (Join-Path $sourceRoot 'src\control.mjs') quit
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 500
        $running = @(Get-CimInstance Win32_Process -Filter "Name = 'CodexAccountRelay.exe'" | Where-Object { $_.ExecutablePath -eq $appExe })
    } while ($running.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($running.Count -gt 0) { throw 'Close the existing relay tray before updating its files.' }
}
$legacyStatus = Join-Path $relayState 'status.json'
if (Test-Path -LiteralPath $legacyStatus) {
    $legacy = Get-Content -LiteralPath $legacyStatus -Raw | ConvertFrom-Json
    if (-not $legacy.managed) { & (Join-Path $sourceRoot 'stop.ps1') }
}
New-Item -Path $appRoot -ItemType Directory -Force | Out-Null
foreach ($folder in @('src', 'scripts')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $folder) -Destination $appRoot -Recurse -Force
}
New-Item -Path (Join-Path $appRoot 'reports') -ItemType Directory -Force | Out-Null
foreach ($file in @('CodexAccountRelay.exe', 'README.txt', 'package.json', 'start.ps1', 'enable.ps1', 'stop.ps1', 'uninstall.ps1')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $file) -Destination (Join-Path $appRoot $file) -Force
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $appRoot 'runtime.json'), (@{node=$nodeExe;stateHome=$relayState} | ConvertTo-Json), $utf8)
$settingsFile = Join-Path $relayState 'settings.json'
if (-not (Test-Path -LiteralPath $settingsFile)) { [IO.File]::WriteAllText($settingsFile, '{"mode":"off"}', $utf8) }
$shortcutShell = New-Object -ComObject WScript.Shell
# Canonical filesystem path, checked outside the Store app's virtual AppData view.
$resolvedExe = & $nodeExe --input-type=module -e "import{realpath}from'node:fs/promises';console.log(await realpath(process.argv[1]));" $appExe
if ($resolvedExe.Trim() -ne $appExe) { throw 'Installation path was redirected; refusing an unreliable startup shortcut.' }
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Account Relay.lnk'
$desktopLink = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Codex Account Relay.lnk'
$shortcutPaths = @($desktopLink)
if ($RegisterWindowsStartup) { $shortcutPaths += $startupLink }
elseif (Test-Path -LiteralPath $startupLink) {
    $previousShortcut = $shortcutShell.CreateShortcut($startupLink)
    if ($previousShortcut.TargetPath -eq $appExe) { Remove-Item -LiteralPath $startupLink }
    else { throw 'The startup shortcut has been edited; refusing to remove an unrelated shortcut.' }
}
foreach ($linkPath in $shortcutPaths) {
    $link = $shortcutShell.CreateShortcut($linkPath)
    $link.TargetPath = $appExe
    $link.WorkingDirectory = $appRoot
    $link.Description = 'Codex account relay - Business first, automatic Pro fallback'
    if ($linkPath -eq $desktopLink) { $link.Arguments = '--show' }
    $link.Save()
}
$appVersion = (Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json).version
$receipt = @{installedAt=[DateTimeOffset]::UtcNow.ToString('o');appRoot=$appRoot;startupLink=$startupLink;desktopLink=$desktopLink;startupRegistered=[bool]$RegisterWindowsStartup;version=$appVersion;node=$nodeExe}
[IO.File]::WriteAllText((Join-Path $relayState 'installation.json'), ($receipt | ConvertTo-Json), $utf8)
# Ask Windows to launch the tray. ShellExecute alone does not guarantee an Explorer parent;
# launching the desktop shortcut directly provides the separately verified user launch path.
$relayWindowsShell = New-Object -ComObject Shell.Application
# The tray has no window at startup. A normal show flag lets its first requested status window appear.
$relayWindowsShell.ShellExecute($appExe, '', $appRoot, 'open', 1)
$unchanged = $authBefore -eq (Get-FileHash -LiteralPath $authFile -Algorithm SHA256).Hash
@{installed=$true;desktopAuthUnchanged=$unchanged;startupRegistered=[bool]$RegisterWindowsStartup;app=$appExe} | ConvertTo-Json

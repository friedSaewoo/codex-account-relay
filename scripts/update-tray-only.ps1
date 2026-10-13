$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$relayState = Join-Path $env:USERPROFILE '.codex-account-relay'
$statusFile = Join-Path $relayState 'manager-status.json'
$appRoot = Join-Path $relayState 'app'
$appExe = Join-Path $appRoot 'CodexAccountRelay.exe'
$sourceExe = Join-Path $sourceRoot 'CodexAccountRelay.exe'
$relayStatus = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
$managerId = [int]$relayStatus.pid
$runtime = Get-Content -LiteralPath (Join-Path $appRoot 'runtime.json') -Raw | ConvertFrom-Json
$managerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $managerId"
if (-not $managerProcess -or $managerProcess.ExecutablePath -ne $runtime.node -or
    -not $managerProcess.CommandLine.Contains((Join-Path $appRoot 'src\manager.mjs')) -or
    $relayStatus.stopped -or ([DateTimeOffset]::UtcNow - [DateTimeOffset]$relayStatus.updated).TotalSeconds -gt 10) {
    throw 'Cannot verify the existing manager; nothing was changed.'
}
$trayProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'CodexAccountRelay.exe'" | Where-Object { $_.ExecutablePath -eq $appExe })
if ($trayProcesses.Count -ne 1) { throw 'Expected one installed tray; nothing was changed.' }
$authFile = Join-Path $env:USERPROFILE '.codex\auth.json'
$configFile = Join-Path $env:USERPROFILE '.codex\config.toml'
$authHash = (Get-FileHash -LiteralPath $authFile).Hash
$configHash = (Get-FileHash -LiteralPath $configFile).Hash
$backupExe = Join-Path $relayState ('tray-backup-' + [Guid]::NewGuid().ToString() + '.exe')
Copy-Item -LiteralPath $appExe -Destination $backupExe
# Stop only the UI process. No quit command, process-tree kill, or manager-file update.
Stop-Process -Id $trayProcesses[0].ProcessId -ErrorAction Stop
Wait-Process -Id $trayProcesses[0].ProcessId -Timeout 10 -ErrorAction SilentlyContinue
if (-not (Get-Process -Id $managerId -ErrorAction SilentlyContinue)) { throw 'The manager unexpectedly stopped; tray replacement was aborted.' }
try {
    $copyDeadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        try { Copy-Item -LiteralPath $sourceExe -Destination $appExe -Force; break }
        catch { if ([DateTime]::UtcNow -ge $copyDeadline) { throw }; Start-Sleep -Milliseconds 250 }
    } while ($true)
} catch {
    # Keep the old UI available if Windows has not released its executable lock.
    Start-Process -FilePath $appExe -WorkingDirectory $appRoot -ArgumentList @('--show', "--attach-manager=$managerId") -WindowStyle Normal
    throw
}
# The requested status window is interactive and must be visible.
$newTray = Start-Process -FilePath $appExe -WorkingDirectory $appRoot -ArgumentList @('--show', "--attach-manager=$managerId") -WindowStyle Normal -PassThru
Start-Sleep -Seconds 2
if ($newTray.HasExited) { throw 'Replacement tray exited unexpectedly.' }
$after = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
if ($after.pid -ne $managerId -or -not (Get-Process -Id $managerId -ErrorAction SilentlyContinue)) { throw 'Manager continuity verification failed.' }
@{trayUpdated=$true;managerUnchanged=$true;configUnchanged=($configHash -eq (Get-FileHash -LiteralPath $configFile).Hash);authUnchanged=($authHash -eq (Get-FileHash -LiteralPath $authFile).Hash);backup=$backupExe} | ConvertTo-Json

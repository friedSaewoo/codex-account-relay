$ErrorActionPreference = 'Stop'
$relayRoot = $PSScriptRoot
$relayState = Join-Path $env:USERPROFILE '.codex-account-relay'
$managedExe = Join-Path $relayState 'app\CodexAccountRelay.exe'
if (Test-Path -LiteralPath $managedExe) {
    Start-Process -FilePath $managedExe -WindowStyle Hidden
    Write-Output 'Automatic relay management is running in the Windows tray.'
    return
}
$relayCli = Join-Path $relayRoot 'src\cli.mjs'
$relayNode = (Get-Command node.exe).Source
$relayStatus = Join-Path $relayState 'status.json'
if (Test-Path -LiteralPath $relayStatus) {
    $existing = Get-Content -LiteralPath $relayStatus -Raw | ConvertFrom-Json
    if ([DateTimeOffset]::UtcNow - ([DateTimeOffset]$existing.updated) -lt [TimeSpan]::FromSeconds(10)) {
        Write-Output 'Relay is already running.'
        exit 0
    }
}
if (-not (Test-Path -LiteralPath $relayState)) { throw 'Run node src/cli.mjs login-business first.' }
$relayProcess = Start-Process -FilePath $relayNode -ArgumentList @('"' + $relayCli + '"', 'serve') -WorkingDirectory $relayRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $relayState 'service.stdout.log') -RedirectStandardError (Join-Path $relayState 'service.stderr.log') -PassThru
Start-Sleep -Seconds 2
if ($relayProcess.HasExited) { throw 'Relay did not start. Check service.stderr.log in the local relay state folder.' }
Write-Output ('Relay started. PID: ' + $relayProcess.Id)

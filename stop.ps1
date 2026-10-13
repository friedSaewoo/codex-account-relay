$ErrorActionPreference = 'Stop'
# Restore the desktop configuration before stopping the server it may depend on.
$relayRoot = $PSScriptRoot
$relayState = Join-Path $env:USERPROFILE '.codex-account-relay'
$managedStatus = Join-Path $relayState 'manager-status.json'
if (Test-Path -LiteralPath $managedStatus) {
    $managed = Get-Content -LiteralPath $managedStatus -Raw | ConvertFrom-Json
    if (-not $managed.stopped -and ([DateTimeOffset]::UtcNow - ([DateTimeOffset]$managed.updated)).TotalSeconds -lt 15) {
        & node (Join-Path $relayRoot 'src\control.mjs') mode off
        Write-Output 'Restoring the default Pro configuration. The tray stays available to serve already-open chats.'
        return
    }
}
$relayConfig = Join-Path $env:USERPROFILE '.codex\config.toml'
if ((Get-Content -LiteralPath $relayConfig -Raw).Contains('# CodexAccountRelay compatibility prototype')) {
    & node (Join-Path $relayRoot 'src\cli.mjs') disable
    if ($LASTEXITCODE -ne 0) { throw 'Config rollback failed. Relay is left running.' }
}
$relayStatus = Join-Path $relayState 'status.json'
if (Test-Path -LiteralPath $relayStatus) {
    $state = Get-Content -LiteralPath $relayStatus -Raw | ConvertFrom-Json
    $owned = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$state.pid)
    $expectedCli = Join-Path $relayRoot 'src\cli.mjs'
    if ($owned -and $owned.Name -eq 'node.exe' -and $owned.CommandLine.Contains($expectedCli)) {
        Stop-Process -Id $state.pid
        Remove-Item -LiteralPath $relayStatus
        Write-Output 'Relay stopped. Restart Codex if it was using the relay.'
    } else { throw 'Saved PID does not match this relay. No process was stopped.' }
}

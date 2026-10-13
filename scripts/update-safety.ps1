function Assert-RelayIdle([string]$relayStatusPath) {
    if (-not (Test-Path -LiteralPath $relayStatusPath)) { throw 'Relay status is unavailable. The running relay was left unchanged.' }
    $relayUpdateStatus = Get-Content -LiteralPath $relayStatusPath -Raw | ConvertFrom-Json
    if ($null -eq $relayUpdateStatus.modelInFlight -or -not $relayUpdateStatus.updated) { throw 'Cannot verify an idle relay. The running relay was left unchanged.' }
    $relayUpdatedAt = [DateTimeOffset]$relayUpdateStatus.updated
    $age = ([DateTimeOffset]::UtcNow - $relayUpdatedAt).TotalSeconds
    if ($age -gt 5 -or $age -lt -5 -or $relayUpdateStatus.modelInFlight -ne 0 -or $relayUpdateStatus.shuttingDown -or
        $relayUpdateStatus.loginInProgress -or $relayUpdateStatus.resetCredits.business.busy -or $relayUpdateStatus.resetCredits.pro.busy) {
        throw 'A Codex response is active or status is stale. Update was deferred; the running relay and configuration were left unchanged.'
    }
}

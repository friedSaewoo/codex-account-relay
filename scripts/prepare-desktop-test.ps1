$ErrorActionPreference = 'Stop'
$relayTestAppRoot = Split-Path -Parent $PSScriptRoot
$relayTestState = Join-Path $env:USERPROFILE '.codex-account-relay'
$relayTestNode = (Get-Command node.exe).Source
$relayTestStatusPath = Join-Path $relayTestState 'manager-status.json'
$relayTestStatus = Get-Content -LiteralPath $relayTestStatusPath -Raw | ConvertFrom-Json
if ($relayTestStatus.stopped -or ([DateTimeOffset]::UtcNow - ([DateTimeOffset]$relayTestStatus.updated)).TotalSeconds -gt 15) {
    throw 'Start the installed relay tray first. Codex is not restarted by this script.'
}
$relayTestReport = Get-Content -LiteralPath (Join-Path $relayTestAppRoot 'reports\live-cli.json') -Raw | ConvertFrom-Json
foreach ($relayTestRoute in @('business', 'pro')) {
    if (-not @($relayTestReport.tests | Where-Object { $_.route -eq $relayTestRoute -and $_.exit -eq 0 -and $_.markerReturned }).Count) {
        throw 'Both isolated account probes must pass before preparing the desktop test.'
    }
}
if (-not $relayTestReport.desktopAuthUnchanged -or -not $relayTestReport.desktopConfigUnchanged) {
    throw 'The isolated probe did not preserve desktop authentication and configuration.'
}
$relayTestAuthModule = Join-Path $relayTestAppRoot 'src\credentials.mjs'
& $relayTestNode --input-type=module -e "import {pathToFileURL} from 'node:url'; const m=await import(pathToFileURL(process.argv[1])); if(!m.isPro(await m.readDesktopAuth()))process.exit(1);" $relayTestAuthModule
if ($LASTEXITCODE -ne 0) { throw 'Keep Codex signed in to the Pro workspace before preparing this test.' }
try {
    & $relayTestNode (Join-Path $relayTestAppRoot 'src\control.mjs') mode auto
    if ($LASTEXITCODE -ne 0) { throw 'Could not request automatic mode.' }
    $relayTestDeadline = [DateTimeOffset]::UtcNow.AddSeconds(90)
    do {
        Start-Sleep -Milliseconds 500
        $relayTestStatus = Get-Content -LiteralPath $relayTestStatusPath -Raw | ConvertFrom-Json
        if ($relayTestStatus.mode -eq 'auto') {
            if ($relayTestStatus.configError) { throw 'Configuration recovery or activation failed.' }
            if (-not $relayTestStatus.desktopReady) { throw 'The desktop Pro login changed.' }
            if ($relayTestStatus.compatibility -eq 'passed' -and $relayTestStatus.configActive) {
                Write-Output 'Ready for desktop validation. Restart Codex when convenient, then continue the existing chat and dot test.'
                return
            }
        }
    } while ([DateTimeOffset]::UtcNow -lt $relayTestDeadline)
    throw 'Compatibility validation did not become ready in time.'
} catch {
    & $relayTestNode (Join-Path $relayTestAppRoot 'src\control.mjs') mode off
    throw
}

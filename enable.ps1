$ErrorActionPreference = 'Stop'
$managedExe = Join-Path $env:USERPROFILE '.codex-account-relay\app\CodexAccountRelay.exe'
if (Test-Path -LiteralPath $managedExe) {
    Start-Process -FilePath $managedExe -WindowStyle Hidden
    & node (Join-Path $PSScriptRoot 'src\control.mjs') mode auto
    Write-Output 'Business-first automatic management requested. Keep Pro signed in. Restart Codex once when convenient.'
    return
}
& (Join-Path $PSScriptRoot 'start.ps1')
& node (Join-Path $PSScriptRoot 'src\cli.mjs') enable
if ($LASTEXITCODE -ne 0) { throw 'Relay activation failed; inspect the message above.' }
Write-Output 'Relay is configured. Restart Codex, keep the Pro login, then continue the existing chat.'

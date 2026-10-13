$ErrorActionPreference = 'Stop'
$relayState = Join-Path $env:USERPROFILE '.codex-account-relay'
$receiptPath = Join-Path $relayState 'installation.json'
if (-not (Test-Path -LiteralPath $receiptPath)) { throw 'No installation receipt found.' }
$receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
$appExe = Join-Path $receipt.appRoot 'CodexAccountRelay.exe'
$nodeExe = (Get-Command node.exe).Source
$running = @(Get-CimInstance Win32_Process -Filter "Name = 'CodexAccountRelay.exe'" | Where-Object { $_.ExecutablePath -eq $appExe })
if ($running.Count -gt 0) { & $nodeExe (Join-Path $PSScriptRoot 'src\control.mjs') quit }
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
    Start-Sleep -Milliseconds 500
    $running = @(Get-CimInstance Win32_Process -Filter "Name = 'CodexAccountRelay.exe'" | Where-Object { $_.ExecutablePath -eq $appExe })
} while ($running.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)
if ($running.Count -gt 0) { throw 'Close the relay tray before uninstalling.' }
# If the manager was already stopped, restore only our managed config block.
$config = Join-Path $env:USERPROFILE '.codex\config.toml'
if ((Get-Content -LiteralPath $config -Raw).Contains('# CodexAccountRelay compatibility prototype')) {
    & $nodeExe (Join-Path $PSScriptRoot 'src\cli.mjs') disable
    if ($LASTEXITCODE -ne 0) { throw 'Configuration rollback needs review; shortcuts were left in place.' }
}
$shortcutShell = New-Object -ComObject WScript.Shell
foreach ($linkPath in @($receipt.startupLink, $receipt.desktopLink)) {
    if (Test-Path -LiteralPath $linkPath) {
        if ($shortcutShell.CreateShortcut($linkPath).TargetPath -ne $appExe) { throw 'Shortcut target changed; refusing to remove it.' }
        Remove-Item -LiteralPath $linkPath
    }
}
Write-Output 'Automatic startup removed and Codex config restored. Restart Codex when convenient. Program files and encrypted Business login were preserved.'

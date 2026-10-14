param([ValidateSet('enable','disable')][string]$Mode = 'enable')
$ErrorActionPreference = 'Stop'
$relayState = if ($env:CODEX_RELAY_HOME) { $env:CODEX_RELAY_HOME } else { Join-Path $env:USERPROFILE '.codex-account-relay' }
$receiptPath = Join-Path $relayState 'installation.json'
$receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
$appExe = Join-Path $receipt.appRoot 'CodexAccountRelay.exe'
if (-not (Test-Path -LiteralPath $appExe)) { throw 'Installed tray executable is unavailable.' }
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Account Relay.lnk'
$shell = New-Object -ComObject WScript.Shell
if (Test-Path -LiteralPath $startupLink) {
    if ($shell.CreateShortcut($startupLink).TargetPath -ne $appExe) { throw 'Startup shortcut belongs to another program; nothing was changed.' }
}
if ($Mode -eq 'enable') {
    $link = $shell.CreateShortcut($startupLink)
    $link.TargetPath = $appExe; $link.WorkingDirectory = $receipt.appRoot
    $link.Arguments = ''; $link.Description = 'Start Codex account relay quietly at Windows sign-in'
    $link.Save()
    $verified = $shell.CreateShortcut($startupLink)
    if ($verified.TargetPath -ne $appExe -or $verified.Arguments -ne '') { throw 'Startup registration verification failed.' }
} elseif (Test-Path -LiteralPath $startupLink) { Remove-Item -LiteralPath $startupLink }
$receipt | Add-Member -NotePropertyName startupRegistered -NotePropertyValue ($Mode -eq 'enable') -Force
$receipt | Add-Member -NotePropertyName startupLink -NotePropertyValue $startupLink -Force
$temp = $receiptPath + '.' + [Guid]::NewGuid().ToString() + '.tmp'
[IO.File]::WriteAllText($temp,($receipt | ConvertTo-Json),(New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath $temp -Destination $receiptPath -Force
@{startupRegistered=($Mode -eq 'enable');trayRestarted=$false} | ConvertTo-Json -Compress

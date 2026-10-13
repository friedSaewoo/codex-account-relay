$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework compiler is unavailable.' }
$target = Join-Path $PSScriptRoot 'CodexAccountRelay.exe'
$appIcon = Join-Path $PSScriptRoot 'assets\app-icon\relay.ico'
& $compiler /nologo /target:winexe /codepage:65001 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll ('/win32icon:' + $appIcon) ('/resource:' + $appIcon + ',RelayIcon') ('/out:' + $target) (Join-Path $PSScriptRoot 'windows\Tray.cs')
if ($LASTEXITCODE -ne 0) { throw 'Tray build failed.' }
Write-Output $target

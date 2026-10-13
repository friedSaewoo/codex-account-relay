param([ValidateSet('protect', 'unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
if ($Mode -eq 'protect') {
    $resultBytes = [System.Security.Cryptography.ProtectedData]::Protect($inputBytes, $null, $scope)
} else {
    $resultBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $null, $scope)
}
[Console]::Out.Write([Convert]::ToBase64String($resultBytes))

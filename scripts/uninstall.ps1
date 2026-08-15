[CmdletBinding()]
param(
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$registeredDirectory = [Environment]::GetEnvironmentVariable('KILO_CONFIG_DIR', 'User')

if (-not $registeredDirectory) {
    Write-Output 'No user-level KILO_CONFIG_DIR registration exists.'
    exit 0
}

$registrationMatches = [IO.Path]::GetFullPath($registeredDirectory).Equals(
    [IO.Path]::GetFullPath($repositoryRoot),
    [StringComparison]::OrdinalIgnoreCase
)

if (-not $registrationMatches -and -not $Force) {
    throw "KILO_CONFIG_DIR points to '$registeredDirectory', not this checkout. Nothing was changed."
}

[Environment]::SetEnvironmentVariable('KILO_CONFIG_DIR', $null, 'User')
if ($registrationMatches -or $Force) {
    Remove-Item Env:KILO_CONFIG_DIR -ErrorAction SilentlyContinue
}

Write-Output 'Removed the user-level KILO_CONFIG_DIR registration.'
Write-Output 'The repository and all existing Kilo configuration were left in place.'

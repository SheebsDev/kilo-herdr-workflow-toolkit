[CmdletBinding()]
param(
    [ValidateSet('Global', 'Project')]
    [string] $Scope = 'Global',
    [string] $ProjectPath,
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path

if ($Scope -eq 'Project') {
    if (-not $ProjectPath) {
        throw 'Project scope requires -ProjectPath.'
    }

    $projectRoot = (Resolve-Path -LiteralPath $ProjectPath -ErrorAction Stop).Path
    $projectConfigRoot = Join-Path $projectRoot '.kilo'
    $manifestPath = Join-Path $projectConfigRoot 'kilo-herdr-engineering-workflow.manifest'

    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        Write-Output "No project workflow installation exists for: $projectRoot"
        exit 0
    }

    foreach ($line in Get-Content -LiteralPath $manifestPath) {
        $parts = $line -split "`t", 2
        if ($parts.Count -ne 2 -or -not $parts[0] -or -not $parts[1]) {
            continue
        }
        if ($parts[1] -ne 'package.json' -and $parts[1] -ne 'package-lock.json' -and $parts[1] -notmatch '^(command|plugin|skills)/') {
            continue
        }

        $installedPath = Join-Path $projectConfigRoot $parts[1]
        if (-not (Test-Path -LiteralPath $installedPath -PathType Leaf)) {
            continue
        }

        $currentHash = (Get-FileHash -LiteralPath $installedPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($currentHash -eq $parts[0].ToLowerInvariant()) {
            Remove-Item -LiteralPath $installedPath -Force
        }
        else {
            Write-Warning "Leaving modified project file in place: $installedPath"
        }
    }

    Remove-Item -LiteralPath $manifestPath -Force
    Write-Output "Removed the project workflow installation from: $projectRoot"
    Write-Output 'Existing project Kilo configuration and dependencies were left in place.'
    exit 0
}

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

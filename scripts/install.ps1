[CmdletBinding()]
param(
    [switch] $Force,
    [switch] $SkipDependencies,
    [switch] $SkipChecks
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$expectedPlugin = Join-Path $repositoryRoot 'plugin\workflow.ts'

if (-not (Test-Path -LiteralPath $expectedPlugin -PathType Leaf)) {
    throw "Workflow plugin not found at $expectedPlugin"
}

$configRegistrations = [ordered]@{
    Process = [Environment]::GetEnvironmentVariable('KILO_CONFIG_DIR', 'Process')
    User = [Environment]::GetEnvironmentVariable('KILO_CONFIG_DIR', 'User')
    Machine = [Environment]::GetEnvironmentVariable('KILO_CONFIG_DIR', 'Machine')
}
$conflictingRegistrations = @(
    foreach ($registration in $configRegistrations.GetEnumerator()) {
        if (
            $registration.Value -and
            -not [IO.Path]::GetFullPath($registration.Value).Equals(
                [IO.Path]::GetFullPath($repositoryRoot),
                [StringComparison]::OrdinalIgnoreCase
            )
        ) {
            "$($registration.Key)='$($registration.Value)'"
        }
    }
)

if ($conflictingRegistrations.Count -gt 0 -and -not $Force) {
    throw "KILO_CONFIG_DIR already has conflicting registrations: $($conflictingRegistrations -join ', '). Re-run with -Force only after deciding to replace the effective registration."
}

$configRoots = @(
    (Join-Path $HOME '.config\kilo'),
    (Join-Path $HOME '.kilo'),
    (Join-Path $HOME '.kilocode')
)
if ($env:XDG_CONFIG_HOME) {
    $configRoots += Join-Path $env:XDG_CONFIG_HOME 'kilo'
}

$existingWorkflowPlugins = @(
    foreach ($configRoot in $configRoots | Select-Object -Unique) {
        if (
            [IO.Path]::GetFullPath($configRoot).Equals(
                [IO.Path]::GetFullPath($repositoryRoot),
                [StringComparison]::OrdinalIgnoreCase
            )
        ) {
            continue
        }

        foreach ($pluginDirectory in 'plugin', 'plugins') {
            foreach ($extension in 'ts', 'js') {
                $candidate = Join-Path $configRoot "$pluginDirectory\workflow.$extension"
                if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                    $candidate
                }
            }
        }
    }
)

if ($existingWorkflowPlugins.Count -gt 0 -and -not $Force) {
    throw "Existing workflow plugins would register duplicate tools: $($existingWorkflowPlugins -join ', '). Migrate them first or re-run with -Force after resolving the duplication."
}

if (-not $SkipDependencies) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'npm was not found. Install Node.js 22.22.2 or newer, or use -SkipDependencies if dependencies are already installed.'
    }

    Push-Location $repositoryRoot
    try {
        & npm ci
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

if (-not $SkipChecks) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'npm was not found, so installation checks cannot run. Use -SkipChecks only when this is intentional.'
    }

    Push-Location $repositoryRoot
    try {
        & npm test
        if ($LASTEXITCODE -ne 0) {
            throw "npm test failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

[Environment]::SetEnvironmentVariable('KILO_CONFIG_DIR', $repositoryRoot, 'User')
$env:KILO_CONFIG_DIR = $repositoryRoot

if (-not (Get-Command kilo -ErrorAction SilentlyContinue)) {
    Write-Warning 'kilo is not currently on PATH. Install Kilo before using the workflow.'
}

if (-not (Get-Command herdr -ErrorAction SilentlyContinue)) {
    Write-Warning 'herdr is not currently on PATH. The parallel workflow requires Herdr.'
}

Write-Output "KILO_CONFIG_DIR registered for the current user: $repositoryRoot"
Write-Output 'Open a new terminal before launching Kilo from Herdr.'

[CmdletBinding()]
param(
    [ValidateSet('Global', 'Project')]
    [string] $Scope = 'Global',
    [string] $ProjectPath,
    [switch] $Force,
    [switch] $SkipDependencies,
    [switch] $SkipChecks
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$expectedPlugin = Join-Path $repositoryRoot 'plugin\workflow.ts'
$manifestName = 'kilo-herdr-engineering-workflow.manifest'

if (-not (Test-Path -LiteralPath $expectedPlugin -PathType Leaf)) {
    throw "Workflow plugin not found at $expectedPlugin"
}

$configRoots = @(
    (Join-Path $HOME '.config\kilo'),
    (Join-Path $HOME '.kilo'),
    (Join-Path $HOME '.kilocode')
)
if ($env:XDG_CONFIG_HOME) {
    $configRoots += Join-Path $env:XDG_CONFIG_HOME 'kilo'
}

function Get-PayloadFiles {
    param([string] $Root)

    $files = @(
        foreach ($directory in 'command', 'core', 'launcher', 'plugin', 'skills') {
            $directoryPath = Join-Path $Root $directory
            if (Test-Path -LiteralPath $directoryPath -PathType Container) {
                Get-ChildItem -LiteralPath $directoryPath -File -Recurse | ForEach-Object {
                    [PSCustomObject] @{
                        FullName = $_.FullName
                        Path = $_.FullName.Substring($Root.Length + 1).Replace('\', '/')
                    }
                }
            }
        }
    )

    foreach ($fileName in 'package.json', 'package-lock.json') {
        $filePath = Join-Path $Root $fileName
        if (Test-Path -LiteralPath $filePath -PathType Leaf) {
            $files += [PSCustomObject] @{
                FullName = $filePath
                Path = $fileName
            }
        }
    }

    return $files
}

function Get-ManifestEntries {
    param([string] $Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @()
    }

    return @(
        foreach ($line in Get-Content -LiteralPath $Path) {
            $parts = $line -split "`t", 2
            if ($parts.Count -eq 2 -and $parts[0] -and $parts[1]) {
                [PSCustomObject] @{
                    Hash = $parts[0]
                    Path = $parts[1]
                }
            }
        }
    )
}

function Get-FileDigest {
    param([string] $Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-ManagedPayloadPath {
    param([string] $Path)

    return $Path -eq 'package.json' -or $Path -eq 'package-lock.json' -or $Path -match '^(command|core|launcher|plugin|skills)/'
}

function Test-SameFile {
    param(
        [string] $First,
        [string] $Second
    )

    return (Get-FileDigest $First) -eq (Get-FileDigest $Second)
}

function Copy-PayloadFiles {
    param(
        [string] $DestinationRoot,
        [object[]] $Files
    )

    foreach ($file in $Files) {
        $destination = Join-Path $DestinationRoot $file.Path
        $parent = Split-Path -Parent $destination
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
    }
}

function Write-Manifest {
    param(
        [string] $Path,
        [string] $Root,
        [object[]] $Files
    )

    $lines = @(
        foreach ($file in $Files) {
            $installedPath = Join-Path $Root $file.Path
            "$(Get-FileDigest $installedPath)`t$($file.Path)"
        }
    )
    Set-Content -LiteralPath $Path -Value $lines -Encoding ASCII
}

function Find-WorkflowPlugins {
    param([string[]] $Roots)

    return @(
        foreach ($root in $Roots | Select-Object -Unique) {
            if (-not $root -or -not (Test-Path -LiteralPath $root -PathType Container)) {
                continue
            }

            foreach ($pluginDirectory in 'plugin', 'plugins') {
                foreach ($extension in 'ts', 'js') {
                    $candidate = Join-Path $root "$pluginDirectory\workflow.$extension"
                    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                        $candidate
                    }
                }
            }
        }
    )
}

if ($Scope -eq 'Project') {
    if (-not $ProjectPath) {
        throw 'Project scope requires -ProjectPath.'
    }

    $projectRoot = (Resolve-Path -LiteralPath $ProjectPath -ErrorAction Stop).Path
    $projectConfigRoot = Join-Path $projectRoot '.kilo'
    $manifestPath = Join-Path $projectConfigRoot $manifestName
    $payloadFiles = @(Get-PayloadFiles $repositoryRoot)
    $oldManifestEntries = @(Get-ManifestEntries $manifestPath)
    $oldManifestPaths = @{}
    foreach ($entry in $oldManifestEntries) {
        $oldManifestPaths[$entry.Path] = $entry
    }

    $globalRoots = @($configRoots + @(
        [Environment]::GetEnvironmentVariable('KILO_CONFIG_DIR', 'Process'),
        [Environment]::GetEnvironmentVariable('KILO_CONFIG_DIR', 'User'),
        [Environment]::GetEnvironmentVariable('KILO_CONFIG_DIR', 'Machine')
    ))
    $existingGlobalPlugins = @(Find-WorkflowPlugins $globalRoots)
    if ($existingGlobalPlugins.Count -gt 0) {
        throw "Project installation would load duplicate workflow plugins: $($existingGlobalPlugins -join ', '). Uninstall the global workflow first."
    }

    if (-not (Test-Path -LiteralPath $projectConfigRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $projectConfigRoot -Force | Out-Null
    }

    if ((Test-Path -LiteralPath (Join-Path $projectConfigRoot 'node_modules') -PathType Container) -and $oldManifestEntries.Count -eq 0) {
        throw "Project config directory already contains node_modules: $projectConfigRoot. Remove or migrate it before installing the workflow."
    }

    foreach ($file in $payloadFiles) {
        $destination = Join-Path $projectConfigRoot $file.Path
        if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
            continue
        }

        $ownedByThisInstall = $oldManifestPaths.ContainsKey($file.Path)
        if (-not $ownedByThisInstall -and -not $Force) {
            throw "Project file already exists: $destination. Re-run with -Force only after deciding to replace it."
        }

        if ($ownedByThisInstall -and -not $Force -and -not (Test-SameFile $destination (Join-Path $repositoryRoot $file.Path))) {
            throw "Installed project file was modified: $destination. Re-run with -Force to replace it."
        }
    }

    $stagingRoot = Join-Path ([IO.Path]::GetTempPath()) "kilo-herdr-workflow-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
    try {
        Copy-PayloadFiles $stagingRoot $payloadFiles

        if (-not $SkipDependencies) {
            if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
                throw 'npm was not found. Install Node.js 22.22.2 or newer, or use -SkipDependencies if dependencies are already installed.'
            }

            Push-Location $stagingRoot
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

        Copy-PayloadFiles $projectConfigRoot $payloadFiles
        if (-not $SkipDependencies) {
            Copy-Item -LiteralPath (Join-Path $stagingRoot 'node_modules') -Destination $projectConfigRoot -Recurse -Force
        }

        foreach ($oldEntry in $oldManifestEntries) {
            if (-not (Test-ManagedPayloadPath $oldEntry.Path)) {
                continue
            }
            if ($payloadFiles.Path -contains $oldEntry.Path) {
                continue
            }

            $stalePath = Join-Path $projectConfigRoot $oldEntry.Path
            if ((Test-Path -LiteralPath $stalePath -PathType Leaf) -and (Get-FileDigest $stalePath) -eq $oldEntry.Hash) {
                Remove-Item -LiteralPath $stalePath -Force
            }
        }

        Write-Manifest $manifestPath $projectConfigRoot $payloadFiles
    }
    finally {
        if (Test-Path -LiteralPath $stagingRoot) {
            Remove-Item -LiteralPath $stagingRoot -Recurse -Force
        }
    }

    if ($SkipDependencies) {
        Write-Warning 'Dependencies were skipped. The project installation requires @kilocode/plugin to be resolvable from the project config directory.'
    }
    Write-Output "Workflow installed for project: $projectRoot"
    Write-Output "Project Kilo configuration: $projectConfigRoot"
    exit 0
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

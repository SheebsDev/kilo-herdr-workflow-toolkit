<#
.SYNOPSIS
  Installs the workflow for the current user or one project.
.DESCRIPTION
  Harness selection is repeatable. Omitting -Harness preserves the historical
  Kilo-only default. The shared transaction performs all preflight, conflict,
  ownership, rollback, and uninstall decisions before mutating a destination.
  Global is retained as a compatibility alias for User scope.
  Project installations may require trust approval in the selected harness.
  Missing CLIs, Node/npm, Herdr, integrations, conflicts, and staging failures
  are reported on stderr and leave destinations unchanged.
.PARAMETER Harness
  One or more of kilo, claude, codex, or all as a comma-separated PowerShell
  array, for example -Harness claude,codex.
.PARAMETER EnvironmentStorePath
  Test-only JSON string map for KILO_CONFIG_DIR. Without it, the user-level
  HKCU\Environment store is used. This prevents automated tests from touching
  the developer environment.
.EXAMPLE
  .\scripts\install.ps1
.EXAMPLE
  .\scripts\install.ps1 -Harness claude,codex
.EXAMPLE
  .\scripts\install.ps1 -Harness kilo
.EXAMPLE
  .\scripts\install.ps1 -Harness claude
.EXAMPLE
  .\scripts\install.ps1 -Harness codex
.EXAMPLE
  .\scripts\install.ps1 -Harness all
.EXAMPLE
  .\scripts\install.ps1 -Scope Project -ProjectPath 'C:\Work\Project' -Harness all
.EXAMPLE
  .\scripts\install.ps1 -Scope User -Harness claude -Update -Force
.EXAMPLE
  .\scripts\install.ps1 -Scope Project -ProjectPath 'C:\Work\Project' -Harness kilo
.EXAMPLE
  .\scripts\install.ps1 -Scope Project -ProjectPath 'C:\Work\Project' -Harness claude
.EXAMPLE
  .\scripts\install.ps1 -Scope Project -ProjectPath 'C:\Work\Project' -Harness codex
#>
[CmdletBinding()]
param(
    [ValidateSet('Global', 'User', 'Project')]
    [string] $Scope = 'Global',
    [string] $ProjectPath,
    [string] $PrivateRestoreRoot,
    [ValidateSet('kilo', 'claude', 'codex', 'all')]
    [string[]] $Harness,
    [switch] $Force,
    [switch] $Update,
    [switch] $SkipDependencies,
    [switch] $SkipChecks,
    [string] $HomePath,
    [string] $EnvironmentStorePath
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$entrypoint = Join-Path $repositoryRoot 'scripts\windows-install.ts'

if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot 'plugin\workflow.ts') -PathType Leaf)) {
    throw "Workflow plugin not found under $repositoryRoot"
}
if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
    throw "Windows installer runtime not found at $entrypoint"
}
if ($Scope -eq 'Project' -and -not $ProjectPath) {
    throw 'Project scope requires -ProjectPath.'
}

$nodeArguments = @('--experimental-strip-types', $entrypoint, 'install', '--scope', $(if ($Scope -eq 'Project') { 'project' } else { 'user' }), '--checkout', $repositoryRoot)
if ($HomePath) { $nodeArguments += @('--home', $HomePath) }
if ($ProjectPath) { $nodeArguments += @('--project', $ProjectPath) }
if ($PrivateRestoreRoot) { $nodeArguments += @('--private-restore-root', $PrivateRestoreRoot) }
if ($Harness) { foreach ($selectedHarness in $Harness) { $nodeArguments += @('--harness', $selectedHarness) } }
if ($Force) { $nodeArguments += '--force' }
if ($Update) { $nodeArguments += '--update' }
if ($SkipDependencies) { $nodeArguments += '--skip-dependencies' }
if ($SkipChecks) { $nodeArguments += '--skip-checks' }
if ($EnvironmentStorePath) { $nodeArguments += @('--environment-store', $EnvironmentStorePath) }

& node @nodeArguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($Scope -ne 'Project' -and ((-not $Harness) -or @($Harness) -contains 'kilo' -or @($Harness) -contains 'all') -and -not $EnvironmentStorePath) {
    $env:KILO_CONFIG_DIR = $repositoryRoot
    Write-Output 'KILO_CONFIG_DIR was registered for the current user. Open a new terminal before launching Kilo from Herdr.'
}

<#
.SYNOPSIS
  Safely uninstalls selected workflow harnesses.
.DESCRIPTION
  Uses the same ownership manifest and transaction engine as installation.
  Omitting -Harness targets the historical Kilo-only user installation.
  Global is retained as a compatibility alias for User scope.
  Modified or shared owned content is retained and reported; workflow history
  and unrelated harness configuration are never removed.
.PARAMETER Harness
  One or more of kilo, claude, codex, or all as a comma-separated PowerShell
  array, for example -Harness claude,codex.
.EXAMPLE
  .\scripts\uninstall.ps1
.EXAMPLE
  .\scripts\uninstall.ps1 -Harness claude,codex
.EXAMPLE
  .\scripts\uninstall.ps1 -Harness kilo
.EXAMPLE
  .\scripts\uninstall.ps1 -Harness claude
.EXAMPLE
  .\scripts\uninstall.ps1 -Harness codex
.EXAMPLE
  .\scripts\uninstall.ps1 -Harness all
.EXAMPLE
  .\scripts\uninstall.ps1 -Scope Project -ProjectPath 'C:\Work\Project' -Harness all
.EXAMPLE
  .\scripts\uninstall.ps1 -Scope Project -ProjectPath 'C:\Work\Project' -Harness kilo
.EXAMPLE
  .\scripts\uninstall.ps1 -Scope Project -ProjectPath 'C:\Work\Project' -Harness claude
.EXAMPLE
  .\scripts\uninstall.ps1 -Scope Project -ProjectPath 'C:\Work\Project' -Harness codex
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
    [string] $HomePath,
    [string] $EnvironmentStorePath
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$entrypoint = Join-Path $repositoryRoot 'scripts\windows-install.ts'
if ($Scope -eq 'Project' -and -not $ProjectPath) {
    throw 'Project scope requires -ProjectPath.'
}

$nodeArguments = @('--experimental-strip-types', $entrypoint, 'uninstall', '--scope', $(if ($Scope -eq 'Project') { 'project' } else { 'user' }), '--checkout', $repositoryRoot)
if ($HomePath) { $nodeArguments += @('--home', $HomePath) }
if ($ProjectPath) { $nodeArguments += @('--project', $ProjectPath) }
if ($PrivateRestoreRoot) { $nodeArguments += @('--private-restore-root', $PrivateRestoreRoot) }
if ($Harness) { foreach ($selectedHarness in $Harness) { $nodeArguments += @('--harness', $selectedHarness) } }
if ($Force) { $nodeArguments += '--force' }
if ($EnvironmentStorePath) { $nodeArguments += @('--environment-store', $EnvironmentStorePath) }

& node @nodeArguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($Scope -ne 'Project' -and ((-not $Harness) -or @($Harness) -contains 'kilo' -or @($Harness) -contains 'all') -and -not $EnvironmentStorePath) {
    $registeredDirectory = $env:KILO_CONFIG_DIR
    if ($registeredDirectory -and [IO.Path]::GetFullPath($registeredDirectory).Equals(
        [IO.Path]::GetFullPath($repositoryRoot),
        [StringComparison]::OrdinalIgnoreCase
    )) {
        Remove-Item Env:KILO_CONFIG_DIR -ErrorAction SilentlyContinue
    }
}

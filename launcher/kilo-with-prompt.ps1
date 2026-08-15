param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string] $PromptPath
)

$ErrorActionPreference = 'Stop'
$promptText = [IO.File]::ReadAllText($PromptPath, [Text.Encoding]::UTF8)

& kilo --agent code --prompt $promptText
exit $LASTEXITCODE

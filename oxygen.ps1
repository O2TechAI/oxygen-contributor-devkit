param([Parameter(ValueFromRemainingArguments = $true)][string[]]$OxygenArgs)

$ErrorActionPreference = 'Stop'
$oxygenNode = if ($env:OXYGEN_NODE) { $env:OXYGEN_NODE } else { 'node' }
Push-Location -LiteralPath (Join-Path $PSScriptRoot 'review-app')
try {
    & $oxygenNode scripts/oxygen.mjs @OxygenArgs
    if ($LASTEXITCODE -ne 0) { throw "Oxygen exited with code $LASTEXITCODE" }
} finally {
    Pop-Location
}

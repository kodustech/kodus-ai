param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ArgsFromCaller
)

$scriptPath = Join-Path $PSScriptRoot "site/install.ps1"
if (-not (Test-Path $scriptPath)) {
    throw "Unable to find site/install.ps1 relative to this script."
}

& $scriptPath @ArgsFromCaller

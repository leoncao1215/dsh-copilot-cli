$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $runtime = Get-ChildItem (Join-Path $PSScriptRoot '.tools') -Directory -Filter 'node-*-win-x64' -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'node.exe') } |
        Select-Object -First 1
    if (-not $runtime) { throw 'Install Node.js 24 or newer before starting.' }
    $env:PATH = "$($runtime.FullName);$env:PATH"
}
Push-Location $PSScriptRoot
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node scripts\start.mjs @args
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}

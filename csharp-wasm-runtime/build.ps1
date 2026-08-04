#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Builds the CSharpRunner WASM AppBundle and copies the output into
    the browser-ide public/runtimes folder.

.DESCRIPTION
    Prerequisites:
      1. .NET SDK 9.0+  ->  https://dotnet.microsoft.com/download
      2. wasm-tools workload:
            dotnet workload install wasm-tools

    Run this script from the csharp-wasm-runtime/ directory:
        .\build.ps1

    The resulting AppBundle is written to:
        ../client/public/runtimes/dotnet-wasm/9.0/
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir  = $PSScriptRoot
$projectDir = Join-Path $scriptDir 'CSharpRunner'
# Join-Path only takes two path segments in Windows PowerShell 5.1 (pwsh 7+ allows
# chaining via -AdditionalChildPath) — nest the calls so this works on both.
$outDir     = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $scriptDir '..') 'client') 'public') 'runtimes') 'dotnet-wasm'
$outDir     = Join-Path $outDir '9.0'

Write-Host "=== CSharpRunner WASM Build ===" -ForegroundColor Cyan

# ── 1. Verify prerequisites ────────────────────────────────────────────────────
try {
    $dotnetVersion = & dotnet --version 2>&1
    Write-Host "  dotnet: $dotnetVersion" -ForegroundColor Green
} catch {
    Write-Error @"
ERROR: 'dotnet' not found.
Install the .NET 9 SDK from: https://dotnet.microsoft.com/download
Then run:  dotnet workload install wasm-tools
"@
    exit 1
}

# ── 2. Ensure wasm-tools workload is installed ─────────────────────────────────
$workloads = & dotnet workload list 2>&1
if ($workloads -notmatch 'wasm-tools') {
    Write-Host "  Installing wasm-tools workload..." -ForegroundColor Yellow
    & dotnet workload install wasm-tools
}

# ── 3. Restore packages ────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Restoring packages..." -ForegroundColor Cyan
& dotnet restore $projectDir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# ── 4. Publish (produces AppBundle) ───────────────────────────────────────────
Write-Host ""
Write-Host "  Publishing browser-wasm AppBundle..." -ForegroundColor Cyan
& dotnet publish $projectDir `
    -c Release `
    -r browser-wasm `
    /p:WasmAppDir="$outDir"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Flatten _framework subfolder if dotnet publish created one
$frameworkDir = Join-Path $outDir '_framework'
if (Test-Path $frameworkDir) {
    Get-ChildItem "$frameworkDir\*" | Move-Item -Destination $outDir -Force
    Remove-Item $frameworkDir -Recurse -Force
}

# ── 5. Write .complete stamp (matches download-runtimes.mjs convention) ────────
Set-Content -Path (Join-Path $outDir '.complete') -Value (Get-Date -Format o)

# ── 6. Report file sizes ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== AppBundle written to: $outDir ===" -ForegroundColor Green
Get-ChildItem $outDir -Recurse -File | ForEach-Object {
    $sizeKB = [math]::Round($_.Length / 1KB, 1)
    Write-Host ("  {0,-50} {1,8} KB" -f $_.Name, $sizeKB)
}

Write-Host ""
Write-Host "Done! Copy the contents of:" -ForegroundColor Cyan
Write-Host "  $outDir" -ForegroundColor White
Write-Host "to the target laptop at the same path, then run 'npm run runtimes' there." -ForegroundColor Cyan

#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Extracts the C# WASM runtime bundle onto this machine so the browser-IDE
    can run .cs files without needing to build anything.

.DESCRIPTION
    Copy the following two files to this machine into the csharp-wasm-runtime/ folder:
        csharp-runtime-9.0.zip    (the runtime bundle)
        install.ps1               (this script)

    Then from csharp-wasm-runtime/ run:
        powershell -ExecutionPolicy Bypass -File install.ps1

    No .NET SDK required on this machine.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Paths ──────────────────────────────────────────────────────────────────────
$scriptDir  = $PSScriptRoot
$zipFile    = Join-Path $scriptDir 'csharp-runtime-9.0.zip'
$destDir    = Join-Path $scriptDir '..' 'client' 'public' 'runtimes' 'dotnet-wasm' '9.0'

Write-Host ""
Write-Host "=== C# WASM Runtime Installer ===" -ForegroundColor Cyan
Write-Host ""

# ── Verify zip exists ──────────────────────────────────────────────────────────
if (-not (Test-Path $zipFile)) {
    Write-Error @"
ERROR: '$zipFile' not found.
Copy 'csharp-runtime-9.0.zip' into the same folder as this script, then re-run.
"@
    exit 1
}

$sizeMB = [math]::Round((Get-Item $zipFile).Length / 1MB, 1)
Write-Host "  Found: csharp-runtime-9.0.zip ($sizeMB MB)" -ForegroundColor Green

# ── Check if already installed ─────────────────────────────────────────────────
$stamp = Join-Path $destDir '.complete'
if (Test-Path $stamp) {
    Write-Host "  Already installed at: $destDir" -ForegroundColor Yellow
    Write-Host "  Delete '$stamp' to force re-install." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Done — no changes made." -ForegroundColor Green
    exit 0
}

# ── Extract ────────────────────────────────────────────────────────────────────
Write-Host "  Extracting to: $destDir ..." -ForegroundColor Cyan
New-Item -ItemType Directory -Path $destDir -Force | Out-Null

# Remove old README placeholder if present
$placeholder = Join-Path $destDir 'README.md'
if (Test-Path $placeholder) { Remove-Item $placeholder -Force }

Expand-Archive -Path $zipFile -DestinationPath $destDir -Force

# Flatten _framework subfolder if present
$frameworkDir = Join-Path $destDir '_framework'
if (Test-Path $frameworkDir) {
    Get-ChildItem "$frameworkDir\*" | Move-Item -Destination $destDir -Force
    Remove-Item $frameworkDir -Recurse -Force
}

# ── Write stamp ────────────────────────────────────────────────────────────────
Set-Content -Path $stamp -Value (Get-Date -Format o)

# ── Report ─────────────────────────────────────────────────────────────────────
$files  = (Get-ChildItem $destDir -Recurse -File).Count
$totalM = [math]::Round((Get-ChildItem $destDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host ""
Write-Host "  Extracted $files files ($totalM MB)" -ForegroundColor Green
Write-Host ""
Write-Host "=== Installation complete! ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. cd client" -ForegroundColor Gray
Write-Host "  2. npm install" -ForegroundColor Gray
Write-Host "  3. npm start" -ForegroundColor Gray
Write-Host "  4. Open a .cs file in the IDE and click Run" -ForegroundColor Gray
Write-Host ""

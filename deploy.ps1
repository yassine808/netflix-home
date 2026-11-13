# Publishes the app to the library drive (G:\NETFLIX by default).
#
# Layout on the target:
#   G:\NETFLIX\Movies\        videos
#   G:\NETFLIX\.cache\        library.db, thumbnails, hero previews, settings
#   G:\NETFLIX\netflix-home.exe
#   G:\NETFLIX\server\ public\ node_modules\ package.json
#
# The launcher starts the server from its own folder, so the deployed copy
# scans G:\NETFLIX (or any folder dropped inside it).

param(
    [string]$Target = "G:\NETFLIX"
)

$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if (-not (Test-Path $Target)) {
    New-Item -ItemType Directory -Path $Target | Out-Null
}

# App code: mirror (removes files deleted from the source).
foreach ($name in @("server", "public")) {
    robocopy (Join-Path $source $name) (Join-Path $Target $name) /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
}
foreach ($file in @("package.json", "package-lock.json")) {
    Copy-Item (Join-Path $source $file) $Target -Force
}

# Dependencies are large; copy them once, then only when they changed.
$targetModules = Join-Path $Target "node_modules"
if (-not (Test-Path (Join-Path $targetModules "express"))) {
    Write-Host "copying node_modules (one time)..."
    robocopy (Join-Path $source "node_modules") $targetModules /E /NFL /NDL /NJH /NJS /NP | Out-Null
}

if (-not (Test-Path $csc)) {
    throw "csc.exe not found at $csc"
}

& $csc /nologo /target:winexe /out:"$source\netflix-home.exe" `
    /win32icon:"$source\public\favicon.ico" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll `
    "$source\launcher.cs"
if ($LASTEXITCODE -ne 0) {
    throw "launcher build failed (exit $LASTEXITCODE)"
}

Copy-Item (Join-Path $source "netflix-home.exe") $Target -Force
Write-Host "deployed to $Target"
Write-Host "launch $Target\netflix-home.exe"
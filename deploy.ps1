# Publishes the single-file build to the library drive (G:\NETFLIX by default).
#
# The app is one self-contained EXE: server, UI, ffmpeg and ffprobe are all
# inside dist\netflix-home.exe. Deployment is therefore a one-file copy.
#
# Layout on the target:
#   G:\NETFLIX\Movies\             videos
#   G:\NETFLIX\.cache\             library.db, pictures.db, hero previews, app assets
#   G:\NETFLIX\netflix-home.exe
#
# Older releases shipped server\ public\ node_modules\ and package.json next to
# the launcher; those are removed so only the EXE remains.

param(
    [string]$Target = "G:\NETFLIX"
)

$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $source "dist\netflix-home.exe"

if (-not (Test-Path $exe)) {
    throw "No build found at $exe. Run 'npm run bundle' first."
}
if (-not (Test-Path $Target)) {
    New-Item -ItemType Directory -Path $Target | Out-Null
}

# A running copy holds the file open; stop it before overwriting. The process
# can take a few seconds to let go of the EXE (antivirus and the crash-safe
# queue writer both touch it), so wait for it to disappear and retry the copy.
Get-Process -Name "netflix-home" -ErrorAction SilentlyContinue | Stop-Process -Force
for ($i = 0; $i -lt 40; $i++) {
    if (-not (Get-Process -Name "netflix-home" -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
}
Start-Sleep -Milliseconds 500

$copied = $false
for ($i = 0; $i -lt 20 -and -not $copied; $i++) {
    try {
        Copy-Item $exe (Join-Path $Target "netflix-home.exe") -Force
        $copied = $true
    } catch {
        if ($i -eq 19) { throw }
        Start-Sleep -Milliseconds 750
    }
}

# Clean up the loose files left by the folder-based deployment.
foreach ($legacy in @("server", "public", "node_modules", "package.json", "package-lock.json")) {
    $path = Join-Path $Target $legacy
    if (Test-Path $path) {
        Remove-Item $path -Recurse -Force
        Write-Host "removed legacy $legacy"
    }
}

$size = [math]::Round((Get-Item (Join-Path $Target "netflix-home.exe")).Length / 1MB, 1)
Write-Host "deployed $size MB to $Target"
Write-Host "launch $Target\netflix-home.exe"
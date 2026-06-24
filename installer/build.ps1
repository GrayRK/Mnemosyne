# Builds the Mnemosyne helper installer (Stage 5.4).
#   1) builds the helper release binary
#   2) ensures bundled tools (yt-dlp/ffmpeg) are present
#   3) compiles the Inno Setup installer -> installer/dist/
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File installer/build.ps1
#
# ASCII-only (Windows PowerShell 5.1 reads -File scripts as ANSI).

$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$helperDir = Join-Path $root 'helper'
$issFile = Join-Path $PSScriptRoot 'mnemosyne.iss'

# --- locate toolchains ---
$go = (Get-Command go -ErrorAction SilentlyContinue).Source
if (-not $go) { $go = 'C:\Program Files\Go\bin\go.exe' }
if (-not (Test-Path $go)) { throw "Go not found (install Go or fix PATH)" }

$iscc = (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source
if (-not $iscc) {
  $candidates = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
  )
  $iscc = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $iscc) { throw "ISCC.exe (Inno Setup) not found" }

# --- 1) build helper ---
Write-Host "Building helper..."
Push-Location $helperDir
try {
  & $go build -o (Join-Path 'bin' 'mnemosyne-helper.exe') .
  if ($LASTEXITCODE -ne 0) { throw "go build failed" }
} finally { Pop-Location }

# --- 2) ensure bundled tools ---
Write-Host "Ensuring bundled tools (yt-dlp/ffmpeg)..."
& powershell -ExecutionPolicy Bypass -File (Join-Path $helperDir 'scripts\fetch-tools.ps1')
if ($LASTEXITCODE -ne 0) { throw "fetch-tools failed" }

# --- 3) compile installer ---
Write-Host "Compiling installer with $iscc ..."
& $iscc $issFile
if ($LASTEXITCODE -ne 0) { throw "ISCC failed" }

Write-Host ''
Write-Host "Done. Installer in installer/dist:"
Get-ChildItem (Join-Path $PSScriptRoot 'dist') -Filter '*.exe' -EA SilentlyContinue |
  Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}} | Format-Table -AutoSize

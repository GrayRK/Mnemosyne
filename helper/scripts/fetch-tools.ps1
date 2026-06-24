# Fetches third-party tools for the helper (yt-dlp + ffmpeg) into helper/tools/.
# These binaries are NOT stored in git (they would bloat the repo) - this script runs
# at release packaging time and for first-time dev setup.
#
# Usage (from anywhere):
#   powershell -ExecutionPolicy Bypass -File helper/scripts/fetch-tools.ps1
#
# Note: ASCII-only on purpose. Windows PowerShell 5.1 reads -File scripts as ANSI,
# so non-ASCII comments can break parsing.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # faster Invoke-WebRequest (no progress UI)

# helper/tools next to this script (scripts/..).
$toolsDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\tools'))
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

$ytDlpExe = Join-Path $toolsDir 'yt-dlp.exe'
$ffmpegExe = Join-Path $toolsDir 'ffmpeg.exe'
$ffprobeExe = Join-Path $toolsDir 'ffprobe.exe'

# --- yt-dlp: single exe from the latest release ---
if (Test-Path $ytDlpExe) {
  Write-Host "yt-dlp already present: $ytDlpExe"
} else {
  $ytUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  Write-Host "Downloading yt-dlp -> $ytDlpExe"
  Invoke-WebRequest -Uri $ytUrl -OutFile $ytDlpExe
}

# --- ffmpeg + ffprobe: from gyan.dev static build (essentials) ---
if ((Test-Path $ffmpegExe) -and (Test-Path $ffprobeExe)) {
  Write-Host "ffmpeg/ffprobe already present in $toolsDir"
} else {
  $ffUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
  $tmpZip = Join-Path $env:TEMP 'mnemosyne-ffmpeg.zip'
  $tmpDir = Join-Path $env:TEMP 'mnemosyne-ffmpeg'
  Write-Host "Downloading ffmpeg -> $tmpZip"
  Invoke-WebRequest -Uri $ffUrl -OutFile $tmpZip
  if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir }
  Write-Host "Extracting ffmpeg..."
  Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force
  $ff = Get-ChildItem -Path $tmpDir -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
  $fp = Get-ChildItem -Path $tmpDir -Recurse -Filter 'ffprobe.exe' | Select-Object -First 1
  if ($null -eq $ff) { throw 'ffmpeg.exe not found in archive' }
  Copy-Item $ff.FullName $ffmpegExe -Force
  if ($null -ne $fp) { Copy-Item $fp.FullName $ffprobeExe -Force }
  Remove-Item -Recurse -Force $tmpDir
  Remove-Item -Force $tmpZip
}

Write-Host ''
Write-Host "Done. Contents of helper/tools:"
Get-ChildItem $toolsDir | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}} | Format-Table -AutoSize

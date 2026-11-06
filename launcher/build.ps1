# Builds MasterCode.exe and drops it at the installation root.
#
# Needs the .NET SDK 8 or newer, and nothing else. The result is self-contained:
# whoever runs it needs Node, but not .NET.
#
#   powershell -ExecutionPolicy Bypass -File launcher\build.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Error 'The .NET SDK is not installed. Get it from https://dotnet.microsoft.com/download'
}

Push-Location $PSScriptRoot
try {
    dotnet publish -c Release -o (Join-Path $root 'dist')
    if ($LASTEXITCODE -ne 0) { Write-Error "dotnet publish failed with exit code $LASTEXITCODE" }
    Copy-Item (Join-Path $root 'dist\MasterCode.exe') (Join-Path $root 'MasterCode.exe') -Force
    $size = [Math]::Round((Get-Item (Join-Path $root 'MasterCode.exe')).Length / 1MB, 1)
    Write-Host ''
    Write-Host "  MasterCode.exe  ($size MB)  ->  $root"
    Write-Host '  Double-click it to start.'
} finally {
    Pop-Location
}

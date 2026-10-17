# Install or upgrade the Hub server as a Windows service (run in an elevated PowerShell from the unpacked release).
# Each version lives in C:\Program Files\PartHub\releases\<version>. Roll back by running the older
# release's install-service.ps1 -Activate (then restore the pre-upgrade backup if the schema changed).
param([switch]$Activate, [int]$Port = 8787)
$ErrorActionPreference = "Stop"
$here = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$version = (Get-Content (Join-Path $here "VERSION")).Trim()
$root = Join-Path $env:ProgramFiles "PartHub"
$dest = Join-Path $root "releases\$version"
$svcDir = "packaging\windows"

$existing = Get-Service -Name PartHub -ErrorAction SilentlyContinue
if ($existing) {
  $current = (Get-CimInstance Win32_Service -Filter "Name='PartHub'").PathName.Trim('"')
  $currentBase = Resolve-Path (Join-Path (Split-Path $current) "..\..")
  if (-not $Activate) {
    # Back up before upgrading (no-op without a backupDir in config.json).
    & (Join-Path $currentBase "node\node.exe") (Join-Path $currentBase "server\dist\cli.js") backup
  }
  & $current stop
  & $current uninstall
}

if (-not $Activate) {
  New-Item -ItemType Directory -Force -Path (Join-Path $root "releases") | Out-Null
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Copy-Item -Recurse $here $dest
}

New-Item -ItemType Directory -Force -Path (Join-Path $env:ProgramData "PartHub\logs") | Out-Null
$exe = Join-Path $dest "$svcDir\part-hub-service.exe"
& $exe install
& $exe start

# LAN access: allow the port on Private networks only.
if (-not (Get-NetFirewallRule -DisplayName "Part Hub server" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "Part Hub server" -Direction Inbound -Protocol TCP -LocalPort $Port -Profile Private -Action Allow | Out-Null
}
Write-Host "Hub server $version is running on port $Port."
Write-Host "First time? Create the owner account:"
Write-Host "  & `"$dest\node\node.exe`" `"$dest\server\dist\cli.js`" create-admin owner"

# Start the NCSC website on this PC only.
# Does not open the K14, publish port 8000, or write either attendance database.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$python = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    throw "Create the virtual environment first: py -3 -m venv .venv"
}
if (-not (Test-Path -LiteralPath (Join-Path $root ".env"))) {
    throw "Copy .env.example to .env and set a private SECRET_KEY before starting."
}
$env:K14_ATTENDANCE_SYNC_ENABLED = "true"
$env:K14_HOST = "192.168.254.201"
$env:K14_PORT = "4370"
$env:K14_LAN_PROBE_ENABLED = "false"
$env:K14_SYNC_INTERVAL_SECONDS = "300"
if (-not $env:K14_CONNECTOR_DB) {
    $env:K14_CONNECTOR_DB = Join-Path $env:LOCALAPPDATA "NCSC-K14-Pilot\attendance.sqlite3"
}
Write-Host "NCSC local site: http://127.0.0.1:8000"
Write-Host "Connector file is read only. The K14 is not contacted by this script."
& $python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

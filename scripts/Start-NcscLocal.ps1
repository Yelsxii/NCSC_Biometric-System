# Start the NCSC website on this PC only.
# Imports into the existing website database only if locally configured.
# Does not contact the K14 or schedule a Windows task.
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
Write-Host "NCSC local site: http://127.0.0.1:8000"
Write-Host "Connector file is read only. The K14 is not contacted by this script."
Write-Host "Using local .env settings (existing process environment variables take precedence)."
& $python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$venvPython = Join-Path $PSScriptRoot ".venv\\Scripts\\python.exe"

if (-not (Test-Path -LiteralPath $venvPython)) {
  Write-Host "Creating local Python virtual environment..."
  if (Get-Command python -ErrorAction SilentlyContinue) {
    python -m venv .venv
  } else {
    py -m venv .venv
  }
}

Write-Host "Installing Python dependencies into .venv..."
& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -r requirements.txt

Write-Host ""
Write-Host "Done. VS Code can use: .venv\\Scripts\\python.exe"

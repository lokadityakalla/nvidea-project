$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$venvPython = Join-Path $PSScriptRoot ".venv\\Scripts\\python.exe"
if (Test-Path -LiteralPath $venvPython) {
  & $venvPython whisper_server.py
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
  python whisper_server.py
} else {
  py whisper_server.py
}

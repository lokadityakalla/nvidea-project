$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

Write-Host ""
Write-Host "Site Meeting Copilot running at:"
Write-Host "  http://127.0.0.1:5500/index.html"
Write-Host ""
Write-Host "Keep this terminal open while using the app."
Write-Host ""

$venvPython = Join-Path $PSScriptRoot ".venv\\Scripts\\python.exe"
if (Test-Path -LiteralPath $venvPython) {
  & $venvPython -m http.server 5500 --bind 127.0.0.1
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
  python -m http.server 5500 --bind 127.0.0.1
} else {
  py -m http.server 5500 --bind 127.0.0.1
}

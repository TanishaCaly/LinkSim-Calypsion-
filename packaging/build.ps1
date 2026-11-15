# Builds the LinkSim tester package: release\LinkSim_Tester.zip
#
# Run from the project folder (C:\LinkSim\linksim):
#     powershell -ExecutionPolicy Bypass -File packaging\build.ps1
#
# Needs: venv312 with requirements.txt + pyinstaller installed, and Node.js
# (frontend\node_modules already installed).
#
# Needs the licensing API key (Backoffice > Settings > API clients, scoped to
# LINKSIM) in the environment — it goes into the build, never into git:
#     $env:LINKSIM_LICENSE_API_KEY = 'lsk_...'
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$python = Join-Path $root 'venv312\Scripts\python.exe'

if (-not $env:LINKSIM_LICENSE_API_KEY) { throw 'Set $env:LINKSIM_LICENSE_API_KEY first (see the top of this file)' }
New-Item -ItemType Directory -Force build | Out-Null
# Read by desktop_launcher.py; build\ is ignored by git.
@{ api_key = $env:LINKSIM_LICENSE_API_KEY } | ConvertTo-Json | Set-Content -Encoding utf8 'build\license_config.json'

Write-Host '1/4  Building the web page (frontend\dist)...'
Push-Location frontend
# vite only (no "tsc -b" type check), same output as "npm run build".
npx vite build
if ($LASTEXITCODE -ne 0) { throw 'Web page build failed' }
Pop-Location

Write-Host '2/4  Building LinkSim.exe...'
& $python -m PyInstaller packaging\linksim.spec --noconfirm --clean --distpath build\dist --workpath build\work
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller build failed' }

Write-Host '3/4  Adding the instructions...'
Copy-Item 'packaging\READ ME FIRST.txt' 'build\dist\LinkSim\READ ME FIRST.txt'

Write-Host '4/4  Zipping...'
New-Item -ItemType Directory -Force release | Out-Null
$zip = 'release\LinkSim_Tester.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path 'build\dist\LinkSim' -DestinationPath $zip
Write-Host "Done: $root\$zip"

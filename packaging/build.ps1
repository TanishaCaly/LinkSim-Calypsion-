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

Write-Host '0/4  Preparing LinkSim''s private PostgreSQL (build\pgsql)...'
# Program files only, from the PostgreSQL 17 installed on this PC; the
# database itself is created on the tester's PC at first start.
$pgSrc = 'C:\Program Files\PostgreSQL\17'
if (-not (Test-Path "$pgSrc\bin\postgres.exe")) { throw "PostgreSQL 17 not found in $pgSrc" }
$pgOut = 'build\pgsql'
if (Test-Path $pgOut) { Remove-Item $pgOut -Recurse -Force }
New-Item -ItemType Directory -Force "$pgOut\bin", "$pgOut\lib", "$pgOut\share" | Out-Null
# The server, its setup and start/stop tools, and the libraries they use
# (not pgAdmin / Stack Builder / client tools).
$pgBin = @('postgres.exe', 'initdb.exe', 'pg_ctl.exe',
           'icudt67.dll', 'icuin67.dll', 'icuuc67.dll', 'icuio67.dll', 'icutu67.dll',
           'libcrypto-3-x64.dll', 'libssl-3-x64.dll', 'libiconv-2.dll', 'libintl-9.dll', 'libxml2.dll',
           'libzstd.dll', 'liblz4.dll', 'zlib1.dll', 'libwinpthread-1.dll', 'libpq.dll')
foreach ($f in $pgBin) { Copy-Item "$pgSrc\bin\$f" "$pgOut\bin\" }
# Microsoft C++ runtime, so testers don't need to install it.
foreach ($f in 'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll') { Copy-Item "$env:WINDIR\System32\$f" "$pgOut\bin\" }
Copy-Item "$pgSrc\lib\*.dll" "$pgOut\lib\"
# Everything the server reads at runtime except the translations (English only).
Get-ChildItem "$pgSrc\share" | Where-Object { $_.Name -ne 'locale' } | Copy-Item -Destination "$pgOut\share\" -Recurse
Copy-Item "$pgSrc\server_license.txt" "$pgOut\"

Write-Host '1/4  Building the web page (frontend\dist)...'
Push-Location frontend
# vite only (no "tsc -b" type check), same output as "npm run build".
npx vite build
if ($LASTEXITCODE -ne 0) { throw 'Web page build failed' }
Pop-Location

Write-Host '2/4  Building LinkSim.exe...'
# backend.storage refuses to load without a PostgreSQL address; PyInstaller
# imports it to find its modules. A placeholder: nothing connects at build time
# (the exe sets the real address of its own database when it starts).
$env:DATABASE_URL = 'postgresql+psycopg://build@127.0.0.1:1/build'
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

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot '.runtime'
$nodeVersion = '22.12.0'
$nodeFolder = Join-Path $runtimeRoot "node-v$nodeVersion-win-x64"
$nodeExe = Join-Path $nodeFolder 'node.exe'
$corepack = Join-Path $nodeFolder 'corepack.cmd'
$pnpm = Join-Path $nodeFolder 'pnpm.cmd'
$appUrl = 'http://127.0.0.1:4173/'

function Test-NutriAIOnline {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $appUrl -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

Write-Host ''
Write-Host '  NutriAI local launcher' -ForegroundColor Cyan
Write-Host '  ======================' -ForegroundColor DarkCyan

if (Test-NutriAIOnline) {
  Write-Host 'NutriAI is already running. Opening it now...' -ForegroundColor Green
  Start-Process $appUrl
  exit 0
}

if (-not (Test-Path $nodeExe)) {
  Write-Host "First launch: downloading portable Node.js $nodeVersion..." -ForegroundColor Yellow
  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  $archive = Join-Path $runtimeRoot "node-v$nodeVersion-win-x64.zip"
  $downloadUrl = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip"
  Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $runtimeRoot -Force
  Remove-Item -LiteralPath $archive -Force
}

if (-not (Test-Path $pnpm)) {
  Write-Host 'Preparing pnpm...' -ForegroundColor Yellow
  & $corepack enable
  if ($LASTEXITCODE -ne 0) { throw 'Unable to enable Corepack.' }
  & $corepack prepare pnpm@11.7.0 --activate
  if ($LASTEXITCODE -ne 0) { throw 'Unable to prepare pnpm.' }
}

$vite = Join-Path $projectRoot 'node_modules\vite\bin\vite.js'
if (-not (Test-Path $vite)) {
  Write-Host 'First launch: installing project dependencies...' -ForegroundColor Yellow
  Push-Location $projectRoot
  try {
    & $pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  } finally {
    Pop-Location
  }
}

Write-Host "Starting NutriAI at $appUrl" -ForegroundColor Green
Write-Host 'Keep this window open while using the application.' -ForegroundColor DarkGray
Start-Process $appUrl
Set-Location $projectRoot
& $nodeExe $vite '--host' '127.0.0.1' '--port' '4173' '--strictPort'
exit $LASTEXITCODE

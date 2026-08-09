$ErrorActionPreference = 'Stop'

$releaseRoot = Resolve-Path (Join-Path $PSScriptRoot '..\release')
$expectedVersion = (Get-Content -Raw (Join-Path $PSScriptRoot '..\apps\desktop\package.json') | ConvertFrom-Json).version
$unpacked = Join-Path $releaseRoot 'win-unpacked'
$resources = Join-Path $unpacked 'resources'
$backend = Join-Path $resources 'backend'
$backendDist = Join-Path $backend 'dist'
$backendModules = Join-Path $backend 'node_modules'
$bundledNode = Join-Path $resources 'bin\node.exe'

foreach ($required in @($unpacked, $backendDist, $backendModules, $bundledNode)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Required packaged path is missing: $required" }
}

$forbiddenDist = Get-ChildItem -LiteralPath $backendDist -Recurse -File | Where-Object {
  $_.FullName -match '[\\/]__tests__[\\/]' -or $_.Name -match '\.(test|spec)\.js$|\.d\.ts$|\.map$'
}
if ($forbiddenDist) { throw "Packaged backend contains test/declaration/map files: $($forbiddenDist[0].FullName)" }

$foreignNative = Get-ChildItem -LiteralPath $backendModules -Recurse -File -Filter '*.node' | Where-Object {
  $_.FullName -match '[\\/]prebuilds[\\/]' -and $_.Name -ne 'win32-x64.node'
}
if ($foreignNative) { throw "Packaged backend contains foreign native prebuild: $($foreignNative[0].FullName)" }

$dependencyTests = Get-ChildItem -LiteralPath $backendModules -Recurse -File | Where-Object {
  $_.FullName -match '[\\/](test|tests|__tests__|spec|fixtures?)[\\/]' -or $_.Name -match '\.(test|spec)\.(js|cjs|mjs|ts)$'
}
if ($dependencyTests) { throw "Packaged backend contains dependency tests/fixtures: $($dependencyTests[0].FullName)" }

$inventory = Join-Path $backendModules '.msc-dependency-inventory.json'
if (-not (Test-Path -LiteralPath $inventory)) { throw 'Packaged dependency inventory is missing' }

$smokeData = Join-Path ([System.IO.Path]::GetTempPath()) ("msc-package-smoke-" + [guid]::NewGuid().ToString('N'))
$stdout = Join-Path $smokeData 'stdout.log'
$stderr = Join-Path $smokeData 'stderr.log'
New-Item -ItemType Directory -Path $smokeData | Out-Null
$token = [guid]::NewGuid().ToString('N')
$oldData = $env:MSC_DATA_DIR
$oldToken = $env:MSC_AUTH_TOKEN
$oldPort = $env:MSC_PORT
$oldVersion = $env:MSC_APP_VERSION
try {
  $env:MSC_DATA_DIR = $smokeData
  $env:MSC_AUTH_TOKEN = $token
  $env:MSC_PORT = '0'
  $env:MSC_APP_VERSION = $expectedVersion
  $entry = Join-Path $backendDist 'index.js'
  $quotedEntry = '"' + $entry + '"'
  $process = Start-Process -FilePath $bundledNode -ArgumentList $quotedEntry -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  $port = $null
  while ([DateTime]::UtcNow -lt $deadline -and -not $process.HasExited) {
    Start-Sleep -Milliseconds 100
    if (Test-Path -LiteralPath $stdout) {
      $match = Select-String -LiteralPath $stdout -Pattern '^MSC_READY ([0-9]+)$' | Select-Object -Last 1
      if ($match) { $port = [int]$match.Matches[0].Groups[1].Value; break }
    }
  }
  if (-not $port) {
    $details = if (Test-Path -LiteralPath $stderr) { Get-Content -Raw $stderr } else { '' }
    throw "Packaged backend did not become ready: $details"
  }
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 8
  if ($health.status -ne 'ok') { throw "Unexpected backend health response: $($health | ConvertTo-Json -Compress)" }
  if ($health.version -ne $expectedVersion) { throw "Packaged backend reports version $($health.version), expected $expectedVersion" }
  $settings = Invoke-RestMethod -Uri "http://127.0.0.1:$port/settings" -Headers @{ 'x-msc-token' = $token } -TimeoutSec 8
  if (-not ($settings.PSObject.Properties.Name -contains 'serverLibraryPath')) { throw 'Authenticated packaged API smoke failed' }
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  $env:MSC_DATA_DIR = $oldData
  $env:MSC_AUTH_TOKEN = $oldToken
  $env:MSC_PORT = $oldPort
  $env:MSC_APP_VERSION = $oldVersion
  Remove-Item -LiteralPath $smokeData -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'Package inventory and bundled backend health checks passed.'

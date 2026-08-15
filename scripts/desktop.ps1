$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))) {
  Write-Host '首次运行，正在安装依赖...'
  npm install
}

$port = 8787
$cfgPath = Join-Path $root 'config.json'
if (Test-Path -LiteralPath $cfgPath) {
  try {
    $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
    if ($cfg.api.port) { $port = [int]$cfg.api.port }
  } catch {}
}

$node = (Get-Command node).Source
$proc = Start-Process -FilePath $node -ArgumentList 'index.js' -WorkingDirectory $root -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2

$url = "http://127.0.0.1:$port"
$edgeCandidates = @(
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
)
$edge = $edgeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

if ($edge) {
  Start-Process -FilePath $edge -ArgumentList "--app=$url"
} else {
  Start-Process $url
}

Write-Host "后端 PID: $($proc.Id)"
Write-Host "面板地址: $url"

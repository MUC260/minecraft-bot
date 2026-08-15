$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$coreExe = Join-Path $root 'dist\minecraft-bot.exe'
$guiExe = Join-Path $root 'launcher\target\release\minecraft-bot-gui.exe'

if (-not (Test-Path -LiteralPath $coreExe)) {
  Write-Host '核心 exe 不存在，先构建核心...'
  & npm run build:exe
  if ($LASTEXITCODE -ne 0) { throw '核心构建失败' }
}

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) { throw '未找到 cargo，请先安装 Rust' }

$toolchain = 'stable-x86_64-pc-windows-gnu'
$hasToolchain = $false
if (Get-Command rustup -ErrorAction SilentlyContinue) {
  $hasToolchain = [bool]((rustup toolchain list) -match [regex]::Escape($toolchain))
}

$dlltoolDirs = @(
  'C:\msys64\ucrt64\bin',
  'C:\msys64\mingw64\bin'
)
$dlltoolDir = $null
$foundDlltool = Get-Command dlltool.exe -ErrorAction SilentlyContinue
if ($foundDlltool -and (Split-Path $foundDlltool.Source) -notlike '*rustup*self-contained*') {
  $dlltoolDir = Split-Path $foundDlltool.Source
} else {
  foreach ($dir in $dlltoolDirs) {
    if (Test-Path -LiteralPath (Join-Path $dir 'dlltool.exe')) {
      $dlltoolDir = $dir
      break
    }
  }
}
if (-not $dlltoolDir) {
  throw '未找到 MinGW-w64 dlltool.exe。请安装 MSYS2/WinLibs，或安装 Visual Studio C++ Build Tools。'
}

$env:Path = "$dlltoolDir;$env:Path"
Set-Location (Join-Path $root 'launcher')
try {
  if ($hasToolchain) {
    & cargo +$toolchain build --release
  } else {
    & cargo build --release
  }
  if ($LASTEXITCODE -ne 0) { throw 'GUI 构建失败' }
} finally {
  Set-Location $root
}

if (-not (Test-Path -LiteralPath $guiExe)) { throw '未找到 GUI 产物' }
Copy-Item -LiteralPath $guiExe -Destination (Join-Path $root 'dist\minecraft-bot-gui.exe') -Force
$size = [math]::Round((Get-Item -LiteralPath (Join-Path $root 'dist\minecraft-bot-gui.exe')).Length / 1MB, 2)
Write-Host "GUI 构建完成: dist\minecraft-bot-gui.exe ($size MiB)"
Write-Host '该 exe 为纯 GUI 子系统，双击不会弹出黑色控制台。'

# fahy installer for Windows.
#
# Installs everything fahy needs, automatically:
#   1. Node.js 18+ via winget (skipped if already present).
#   2. mpv + yt-dlp via winget (skip with -SkipDeps).
#   3. fahy globally via npm (registry, or GitHub source pre-publish).
#   4. Runs `fahy --doctor` to prove the install.
#
# Usage:
#   irm https://raw.githubusercontent.com/emmanagellon/fahy-cli/main/install.ps1 | iex
#   # or with options:
#   & ([scriptblock]::Create((iwr -useb https://raw.githubusercontent.com/emmanagellon/fahy-cli/main/install.ps1))) -Version latest -Method npm
param(
  [string]$Version = "latest",
  [ValidateSet("npm", "source")][string]$Method = "npm",
  [switch]$SkipDeps,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$Repo = "emmanagellon/fahy-cli"
$Pkg = "fahy-cli"
$NodeWingetId = "OpenJS.NodeJS.LTS"

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Have($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# The installer may have just put a tool on disk (Node, npm shims) that this
# session doesn't know yet - prepend it to this process's PATH (idempotent).
function Add-SessionPath($dir) {
  if ((Test-Path $dir) -and (($env:Path -split ';') -notcontains $dir)) {
    $env:Path = "$dir;$env:Path"
  }
}

function Install-Winget($id, $name) {
  if ($DryRun) {
    Write-Host "[dry-run] would run: winget install --id $id -e" -ForegroundColor Yellow
    return
  }
  if (-not (Have winget)) {
    throw "$name is missing and winget was not found. Install $name manually, then re-run with -SkipDeps."
  }
  winget install --id $id -e --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "winget could not install $name (exit $LASTEXITCODE). Try running this script as Administrator."
  }
}

function Get-NodeMajor() {
  if (-not (Have node)) { return 0 }
  return [int](((& node --version) -replace '^v', '') -split '\.')[0]
}

# 1. Node.js ---------------------------------------------------------------
Step "Checking Node.js"
$major = Get-NodeMajor
if ($major -ge 18) {
  Write-Host "Node.js $(& node --version) ok ($((Get-Command node).Source))" -ForegroundColor Green
} elseif ($SkipDeps) {
  $found = if ($major -eq 0) { 'none' } else { & node --version }
  throw "Node.js 18+ is required but not installed (found: $found). Re-run without -SkipDeps to auto-install it."
} elseif ($major -eq 0) {
  Step "Installing Node.js LTS (winget)"
  Install-Winget $NodeWingetId "Node.js"
  Add-SessionPath "$env:ProgramFiles\nodejs"
  Add-SessionPath (Join-Path $env:APPDATA 'npm')
} else {
  Write-Host "Node.js $(& node --version) is too old - upgrading to LTS..." -ForegroundColor Yellow
  if ($DryRun) {
    Write-Host "[dry-run] would run: winget upgrade --id $NodeWingetId -e" -ForegroundColor Yellow
  } else {
    try {
      if (-not (Have winget)) { throw "no winget" }
      winget upgrade --id $NodeWingetId -e --accept-source-agreements --accept-package-agreements
      if ($LASTEXITCODE -ne 0) { throw "winget exit $LASTEXITCODE" }
      Add-SessionPath "$env:ProgramFiles\nodejs"
    } catch {
      throw "Could not auto-upgrade Node.js (it may not be a winget install). Update it manually to 18+, then re-run."
    }
  }
}
if (-not $DryRun -and $major -lt 18) {
  # Re-verify after an install/upgrade (same path, fresh process - no new terminal needed).
  $major = Get-NodeMajor
  if ($major -lt 18) {
    throw "Node.js 18+ still not on PATH in this session. Open a new terminal and re-run the installer."
  }
  Write-Host "Node.js $(& node --version) ok ($((Get-Command node).Source))" -ForegroundColor Green
}

# 2. Player + downloader ----------------------------------------------------
if (-not $SkipDeps) {
  Step "Installing mpv + yt-dlp (winget)"
  $deps = @(
    @{ Id = "mpv-player.mpv-CI.MSVC"; Name = "mpv" },
    @{ Id = "yt-dlp.yt-dlp"; Name = "yt-dlp" }
  )
  foreach ($d in $deps) {
    if (Have $d.Name) {
      Write-Host "$($d.Name) already installed." -ForegroundColor Green
    } else {
      Write-Host "Installing $($d.Name)..."
      Install-Winget $d.Id $d.Name
    }
  }
  Add-SessionPath (Join-Path $env:APPDATA 'npm')
} else {
  Write-Host "Skipping dependency install (-SkipDeps)." -ForegroundColor Yellow
}

# 3. fahy itself -------------------------------------------------------------
if ($Method -eq "npm") {
  $spec = if ($Version -eq "latest") { $Pkg } else { "$Pkg@$Version" }
} else {
  $ref = if ($Version -eq "latest") { "" } else { "#$Version" }
  $spec = "github:$Repo$ref"
}
Step "Installing fahy (${Method}: $spec)"
if ($DryRun) {
  Write-Host "[dry-run] would run: npm install -g $spec" -ForegroundColor Yellow
  Write-Host "[dry-run] then: fahy --doctor" -ForegroundColor Yellow
  exit 0
}
npm install -g $spec
if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)." }

# 4. Verify ------------------------------------------------------------------
Step "Verifying"
fahy --doctor
Write-Host "`nDone. Try: fahy   (fullscreen shell)   or   fahy -m -S ""lofi""" -ForegroundColor Green
Write-Host "Keep it current: fahy upgrade      Remove it: fahy uninstall" -ForegroundColor DarkGray

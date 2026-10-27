<#
.SYNOPSIS
  Install Skill Vault for the current user: check Node and git, install
  packages, build, and add a "Skill Vault" folder to the Start Menu.
  Safe to re-run (repairs shortcuts and rebuilds).
.EXAMPLE
  .\setup.cmd              # install
  .\setup.cmd -Desktop     # also add a desktop shortcut
  .\setup.cmd -WhatIf      # show what would happen, change nothing
  .\setup.cmd -Uninstall   # remove the shortcuts (never the clone, your vault or ~/.skill-vault)
#>
[CmdletBinding(SupportsShouldProcess)]
param([switch]$Desktop, [switch]$Uninstall, [switch]$NoLaunch)

$ErrorActionPreference = 'Stop'
$Repo       = $PSScriptRoot
$App        = Join-Path $Repo 'app'
$Programs   = [Environment]::GetFolderPath('Programs')
$StartMenu  = Join-Path $Programs 'Skill Vault'
$DesktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Skill Vault.lnk'
$LegacyLnk  = Join-Path $Programs 'Apps\Skill Vault App.lnk'
$Launch     = Join-Path $App 'scripts\launch.ps1'
$Icon       = Join-Path $App 'assets\skill-vault.ico'
$WinPS      = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Conhost    = Join-Path $env:SystemRoot 'System32\conhost.exe'

function Write-Step([string]$m) { Write-Host "  > $m" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn([string]$m) { Write-Host "    ! $m" -ForegroundColor Yellow }
function Stop-Setup([string]$m) { Write-Host "    x $m" -ForegroundColor Red; exit 1 }

function New-Shortcut([string]$Path, [string]$Target, [string]$Arguments, [string]$WorkDir, [string]$Description, [int]$WindowStyle) {
  if (-not $PSCmdlet.ShouldProcess($Path, 'Create shortcut')) { return }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($Path)
  $s.TargetPath = $Target
  $s.Arguments = $Arguments
  $s.WorkingDirectory = $WorkDir
  $s.IconLocation = $Icon
  $s.Description = $Description
  $s.WindowStyle = $WindowStyle
  $s.Save()
  Write-Ok "shortcut: $Path"
}

if ($Uninstall) {
  Write-Step 'Removing Skill Vault shortcuts'
  foreach ($p in @($StartMenu, $DesktopLnk)) {
    if ((Test-Path -LiteralPath $p) -and $PSCmdlet.ShouldProcess($p, 'Remove')) {
      Remove-Item -LiteralPath $p -Recurse -Force
      Write-Ok "removed $p"
    }
  }
  Write-Ok 'Done. The clone, your vault and ~/.skill-vault were not touched.'
  exit 0
}

Write-Host ''
Write-Host '  Skill Vault setup' -ForegroundColor White
Write-Host ''

Write-Step 'Checking prerequisites'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-Setup 'Node.js 20 or newer is required. Install it with:  winget install OpenJS.NodeJS.LTS   then open a new terminal and run setup again.'
}
$nodeVersion = (& node --version).Trim()
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) {
  Stop-Setup "Node.js 20 or newer is required (found $nodeVersion). Update with:  winget upgrade OpenJS.NodeJS.LTS"
}
Write-Ok "node $nodeVersion"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Stop-Setup 'git is required. Install it with:  winget install Git.Git   then open a new terminal and run setup again.'
}
Write-Ok ((& git --version).Trim())
if (Get-Command claude -ErrorAction SilentlyContinue) {
  Write-Ok 'claude CLI found'
} else {
  Write-Warn 'claude CLI not found. The AI assistant, AI tagging and Claude merge need it (https://claude.com/claude-code); everything else works.'
}

Write-Step 'Installing packages'
if ($PSCmdlet.ShouldProcess($App, 'npm ci --include=dev')) {
  Push-Location $App
  try {
    Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
    & npm ci --include=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Stop-Setup 'npm ci failed (see the output above).' }
  } finally { Pop-Location }
}

Write-Step 'Building the app'
if ($PSCmdlet.ShouldProcess($App, 'npm run build')) {
  Push-Location $App
  try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { Stop-Setup 'The build failed (see the output above).' }
  } finally { Pop-Location }
}

Write-Step 'Creating shortcuts'
# conhost --headless runs the launcher with no window at all, even when
# Windows Terminal is the default console (powershell -WindowStyle Hidden can't hide that).
$launchArgs = "--headless `"$WinPS`" -NoProfile -ExecutionPolicy Bypass -File `"$Launch`""
New-Shortcut (Join-Path $StartMenu 'Skill Vault.lnk') $Conhost $launchArgs $App 'Open Skill Vault' 1
New-Shortcut (Join-Path $StartMenu 'Uninstall Skill Vault shortcuts.lnk') $WinPS "-NoProfile -ExecutionPolicy Bypass -File `"$Repo\setup.ps1`" -Uninstall" $Repo 'Remove the Skill Vault shortcuts' 1
if ($Desktop) {
  New-Shortcut $DesktopLnk $Conhost $launchArgs $App 'Open Skill Vault' 1
}

if (Test-Path -LiteralPath $LegacyLnk) {
  $old = (New-Object -ComObject WScript.Shell).CreateShortcut($LegacyLnk).TargetPath
  if ($old -and ($old -eq (Join-Path $App 'run.bat')) -and $PSCmdlet.ShouldProcess($LegacyLnk, 'Remove the old shortcut')) {
    Remove-Item -LiteralPath $LegacyLnk -Force
    Write-Ok "removed the old shortcut $LegacyLnk"
  }
}

Write-Host ''
Write-Host '  Skill Vault is installed. Open it from the Start Menu: Skill Vault.' -ForegroundColor Green
Write-Host ''
if (-not $NoLaunch -and -not $WhatIfPreference -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
  $answer = Read-Host '  Open Skill Vault now? [Y/n]'
  if ($answer -eq '' -or $answer -match '^[Yy]') {
    & $WinPS -NoProfile -ExecutionPolicy Bypass -File $Launch
    if ($LASTEXITCODE -ne 0) {
      Write-Warn ("Skill Vault didn't open. Details: " + (Join-Path $env:USERPROFILE '.skill-vault\logs\launch.log'))
    }
  }
}

<#
  Skill Vault launcher: what the Start Menu shortcut runs, with no window.

  1. Reuse a running server (~/.skill-vault/app.lock + GET /api/health).
  2. Otherwise rebuild if the source is newer than dist/ (scripts/build-state.mjs
     exits 10), then start the built server hidden with --exit-when-idle,
     bound to 127.0.0.1 (a desktop app; the health probe and window use it).
  3. Open an Edge app window (default browser if Edge isn't installed).

  -Headless (used by the vault bridge for Claude Desktop, Claude Code and
  the skill-vault command): steps 1-2 only, no window. Failures go to the
  log and exit 1 without a message box, so repeated agent calls don't
  stack dialogs.

  Steps 1-3 run one launch at a time per user (a named mutex), so quick
  double-clicks reuse the first server instead of starting a second one or
  rebuilding dist/ twice.

  Steps go to ~/.skill-vault/logs/launch.log; any failure shows a message box
  naming the log. Windows PowerShell 5.1 compatible.
#>
param([switch]$Headless)
$ErrorActionPreference = 'Stop'
$AppDir    = Split-Path -Parent $PSScriptRoot
$SvDir     = Join-Path $env:USERPROFILE '.skill-vault'
$LogDir    = Join-Path $SvDir 'logs'
$LockFile  = Join-Path $SvDir 'app.lock'
$LaunchLog = Join-Path $LogDir 'launch.log'
$ServerLog = Join-Path $LogDir 'server.log'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log([string]$Message) {
  Add-Content -LiteralPath $LaunchLog -Value ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $Message)
}

function Stop-WithError([string]$Message) {
  Write-Log "ERROR: $Message"
  if ($Headless) { exit 1 }
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("$Message`n`nDetails: $LaunchLog", 'Skill Vault', 'OK', 'Error') | Out-Null
  exit 1
}

# A lock left by a server that never got to remove it (logoff, crash, taskkill)
# can name a pid Windows has since given to another process. It is stale when
# that process isn't node, or started after the lock was written. When unsure
# (StartTime or started_at unreadable) a node process is trusted.
function Test-StaleLock($Lock, $Process) {
  if ($Process.ProcessName -ne 'node') { return $true }
  try {
    $written = $Lock.started_at
    if (-not ($written -is [DateTime])) {
      $written = [DateTime]::Parse([string]$written, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    }
    return ($Process.StartTime.ToUniversalTime() -gt $written.ToUniversalTime())
  } catch {
    return $false
  }
}

function Get-LiveServer {
  if (-not (Test-Path -LiteralPath $LockFile)) { return $null }
  try { $lock = Get-Content -LiteralPath $LockFile -Raw | ConvertFrom-Json } catch { return $null }
  if (-not $lock -or -not ($lock.pid -is [int] -or $lock.pid -is [long]) -or -not ($lock.port -is [int] -or $lock.port -is [long])) { return $null }
  $process = Get-Process -Id $lock.pid -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  if (Test-StaleLock $lock $process) {
    Write-Log "removing a stale app.lock (pid $($lock.pid) is now $($process.ProcessName), not the server that wrote it)"
    Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
    return $null
  }
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($lock.port)/api/health" -TimeoutSec 2
    if ($health.ok -and $health.pid -eq $lock.pid) { return $lock }
  } catch { }
  return $null
}

function Find-Edge {
  foreach ($key in 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe',
                   'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe') {
    $item = Get-Item -LiteralPath $key -ErrorAction SilentlyContinue
    if ($item) {
      $exe = $item.GetValue('')
      if ($exe -and (Test-Path -LiteralPath $exe)) { return $exe }
    }
  }
  return $null
}

function Open-AppWindow([int]$Port) {
  $url = "http://localhost:$Port/"
  $edge = Find-Edge
  if ($edge) {
    Start-Process -FilePath $edge -ArgumentList "--app=$url"
    Write-Log "opened an Edge app window at $url"
  } else {
    Start-Process $url
    Write-Log "Edge not found; opened $url in the default browser"
  }
}

try {
  Write-Log $(if ($Headless) { '--- launch (headless)' } else { '--- launch' })
  # One launch at a time: a second click waits here, then finds the first
  # click's server and reuses it. A launcher that died holding the mutex
  # leaves it abandoned, which the next WaitOne reports and we take over.
  $mutex = New-Object System.Threading.Mutex($false, 'Local\SkillVaultLauncher')
  $owned = $false
  try {
    try { $owned = $mutex.WaitOne([TimeSpan]::FromSeconds(120)) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { Stop-WithError 'Another Skill Vault launch is still starting. Try again in a moment.' }

    $live = Get-LiveServer
    if ($live) {
      Write-Log "reusing the running server (pid $($live.pid), port $($live.port))"
    } else {
      $node = Get-Command node -ErrorAction SilentlyContinue
      if (-not $node) { Stop-WithError 'Node.js was not found. Install it (winget install OpenJS.NodeJS.LTS), then run setup.cmd again.' }

      Push-Location $AppDir
      try {
        & $node.Source 'scripts/build-state.mjs'
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 10) {
          Stop-WithError "Couldn't check whether Skill Vault needs rebuilding (build-state exit $LASTEXITCODE). Run setup.cmd again."
        }
        if ($LASTEXITCODE -eq 10) {
          Write-Log 'the source changed since the last build; rebuilding'
          Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
          # cmd /c keeps npm's stderr from becoming a terminating PowerShell error.
          cmd /c "npm run build >> `"$LaunchLog`" 2>&1"
          if ($LASTEXITCODE -ne 0) { Stop-WithError 'Rebuilding Skill Vault failed.' }
        }
      } finally {
        Pop-Location
      }

      $env:NODE_ENV = 'production'
      # 127.0.0.1 explicitly: a HOST setting (.env or config) must not move the
      # server somewhere the health probe below can't reach.
      $serverArgs = @('dist/launcher.js', '--no-open', '--host', '127.0.0.1', '--exit-when-idle', '--log-file', "`"$ServerLog`"")
      Start-Process -FilePath $node.Source -ArgumentList $serverArgs -WorkingDirectory $AppDir -WindowStyle Hidden
      $deadline = (Get-Date).AddSeconds(20)
      while (-not ($live = Get-LiveServer)) {
        if ((Get-Date) -gt $deadline) { Stop-WithError "Skill Vault didn't start within 20 seconds. Server log: $ServerLog" }
        Start-Sleep -Milliseconds 250
      }
      Write-Log "started the server (pid $($live.pid), port $($live.port))"
    }
    if ($Headless) { Write-Log 'headless: no window' } else { Open-AppWindow ([int]$live.port) }
  } finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
} catch {
  Stop-WithError "Skill Vault couldn't start: $($_.Exception.Message)"
}

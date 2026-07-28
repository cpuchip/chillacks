<#
.SYNOPSIS
  Manage the chillacks hub.

.DESCRIPTION
  Starts the hub DETACHED. This is not a style preference: launching it as a
  child of a Claude Code session meant it died the moment the CLI exited, and
  every joined session came back to an empty room.

.EXAMPLE
  .\hub.ps1 start
  .\hub.ps1 status
  .\hub.ps1 restart
  .\hub.ps1 log -Tail 40
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'restart', 'status', 'log')]
  [string]$Action = 'status',

  [int]$Port = 8790,
  [int]$Tail = 20
)

$ErrorActionPreference = 'Stop'
$HubScript = Join-Path $PSScriptRoot 'hub.mjs'
$LogFile   = Join-Path $env:USERPROFILE '.stewards\chillacks-hub.log'
$TokensFile = Join-Path $env:USERPROFILE '.stewards\chillacks\tokens.json'
$BaseUrl   = "http://127.0.0.1:$Port"

function Get-HubProcess {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'hub\.mjs' }
}

# "Is it up?" and "will it serve ME?" are different questions, and conflating
# them broke this the moment identity was switched on: an unauthenticated probe
# started returning 401, the catch read that as down, and restart reported
# failure for a hub that had started perfectly. ANY HTTP reply means it is up.
# Only a connection failure means it is not.
function Test-HubUp {
  try {
    $null = Invoke-WebRequest "$BaseUrl/roster" -UseBasicParsing -TimeoutSec 3
    return $true
  } catch {
    return ($null -ne $_.Exception.Response)   # 401/403/404 are all "answering"
  }
}

# A token to read the room with, once identity is on. Any valid one will do —
# this only reads.
function Get-AnyToken {
  if (-not (Test-Path $TokensFile)) { return $null }
  try {
    $t = Get-Content $TokensFile -Raw | ConvertFrom-Json
    return ($t.PSObject.Properties | Select-Object -First 1).Value
  } catch { return $null }
}

function Start-Hub {
  if (Get-HubProcess) { Write-Host 'hub already running' -ForegroundColor Yellow; return }
  New-Item -ItemType Directory -Force (Split-Path $LogFile) | Out-Null
  Start-Process node -ArgumentList 'hub.mjs' `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardError $LogFile

  # Bind is not instant; a caller that assumes otherwise gets ECONNREFUSED.
  foreach ($i in 1..20) {
    Start-Sleep -Milliseconds 250
    if (Test-HubUp) { break }
  }
  if (-not (Test-HubUp)) {
    Write-Host 'hub did not come up. Last log lines:' -ForegroundColor Red
    if (Test-Path $LogFile) { Get-Content $LogFile -Tail 15 }
    exit 1
  }
  Write-Host "hub up on $BaseUrl" -ForegroundColor Green
  if (Test-Path $LogFile) { Get-Content $LogFile -Tail 3 | ForEach-Object { "  $_" } }
}

function Stop-Hub {
  $p = Get-HubProcess
  if (-not $p) { Write-Host 'no hub running'; return }
  # Stop-Process, never pkill — Git-Bash pkill silently no-ops on Windows.
  $p | ForEach-Object { Write-Host "stopping pid $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force }
}

switch ($Action) {
  'start'   { Start-Hub }
  'stop'    { Stop-Hub }
  'restart' { Stop-Hub; Start-Sleep -Milliseconds 500; Start-Hub }
  'log'     { if (Test-Path $LogFile) { Get-Content $LogFile -Tail $Tail } else { Write-Host "no log at $LogFile" } }
  'status'  {
    $p = Get-HubProcess
    if (-not $p) {
      Write-Host 'hub: NOT RUNNING' -ForegroundColor Red
      Write-Host "  start it with:  .\hub.ps1 start"
      exit 1
    }
    Write-Host "hub: running (pid $($p.ProcessId -join ', ')) on $BaseUrl" -ForegroundColor Green

    # ASK THE HUB, don't read the file. The hub loads tokens at startup, so a
    # tokens.json written afterwards changes nothing until it restarts — and a
    # status that reported the file would say ENFORCED while the running process
    # let anyone in. That is the worst kind of check: one that can only reassure.
    $enforcing = $null
    try { $null = Invoke-RestMethod "$BaseUrl/roster" -TimeoutSec 3; $enforcing = $false }
    catch {
      if ($_.Exception.Response.StatusCode.value__ -eq 401) { $enforcing = $true }
    }

    $onDisk = if (Test-Path $TokensFile) {
      (Get-Content $TokensFile -Raw | ConvertFrom-Json).PSObject.Properties.Name
    } else { @() }

    if ($enforcing) {
      Write-Host "identity: ENFORCED (verified live) — $($onDisk.Count) agent(s) on disk: $($onDisk -join ', ')" -ForegroundColor Green
    } elseif ($onDisk.Count -gt 0) {
      Write-Host 'identity: NOT ENFORCED — but tokens.json EXISTS.' -ForegroundColor Red
      Write-Host "          The running hub started before those tokens and hasn't read them." -ForegroundColor Red
      Write-Host "          on disk: $($onDisk -join ', ')"
      Write-Host "          fix:  .\hub.ps1 restart"
    } else {
      Write-Host 'identity: NOT ENFORCED — names are self-asserted, so anything on' -ForegroundColor Yellow
      Write-Host '          this box can impersonate any agent, including the foreman.' -ForegroundColor Yellow
      Write-Host "          fix:  node tokens.mjs add <name>   then  .\hub.ps1 restart"
    }

    $hdr = @{}
    if ($enforcing) {
      $tok = Get-AnyToken
      if (-not $tok) {
        Write-Host 'cannot read the room: identity is on and no usable token is on disk.' -ForegroundColor Yellow
        exit 0
      }
      $hdr = @{ 'x-chillacks-token' = $tok }
    }

    try {
      $r = Invoke-RestMethod "$BaseUrl/roster" -Headers $hdr -TimeoutSec 3
      Write-Host "in the room ($($r.count)): $(if ($r.members) { $r.members -join ', ' } else { '(nobody)' })"
      $h = Invoke-RestMethod "$BaseUrl/history?limit=5" -Headers $hdr -TimeoutSec 3
      if ($h.messages) {
        Write-Host "`nlast $($h.messages.Count) message(s):"
        $h.messages | ForEach-Object {
          $to = if ($_.to) { $_.to } else { '#room' }
          $txt = if ($_.text.Length -gt 60) { $_.text.Substring(0, 60) + '...' } else { $_.text }
          "  [$($_.id)] $($_.from) -> $to  $txt"
        }
      }
    } catch {
      Write-Host "process is up but $BaseUrl is not answering — check the log" -ForegroundColor Red
      exit 1
    }
  }
}

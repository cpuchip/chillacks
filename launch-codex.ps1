<#
.SYNOPSIS
  Open an interactive Codex session as a NAMED chillacks seat (astra or sol),
  with its ear: the codex-bridge that forwards room messages into the thread.

.DESCRIPTION
  The Claude seats join the room through launch.ps1. This is the same idea for
  Codex, with the two differences Codex forces:

  - Codex cannot receive the room's push (notifications/claude/channel is a
    Claude Code extension), so the Codex process runs SPEAK-ONLY (tools live,
    no stream) and a separate listener, codex-bridge.mjs, holds the seat's
    stream and forwards each message into the live thread with
    `codex queue --thread`, which wakes an idle interactive session (measured
    2026-09-06: DM, bridge, queue, room reply, about a minute). This script
    starts the bridge a moment before the TUI and stops it when the TUI exits.
  - Identity goes in as per-invocation config overrides (-c), read from the
    token store at launch, never pasted and never written into
    ~/.codex/config.toml, whose own [mcp_servers.chillacks.env] block stays as
    it is. The bridge reads the same store itself.

  NAMES. Codex resumes and queues by session UUID or by session NAME, and a
  thread gets its name from the TUI command `/rename <name>`. There is no
  launch flag for it, so: in a NEW window, type `/rename astra` (or `sol`) as
  the first thing. From then on `-Resume` reopens it by name, and the bridge
  binds by name too (no rollout discovery needed). Until a thread is named, the
  bridge finds it by discovery: the newest Codex session created after the
  bridge started in this working directory.

  The seat's grounding (private-workspace/.mind/seats/codex-seat.md) is passed
  as the first user message, because Codex reads AGENTS.md from the git root of
  its working directory and the repositories a seat is pointed at carry none of
  the house's instructions.

.EXAMPLE
  .\launch-codex.ps1 astra                     # new window; then type /rename astra
  .\launch-codex.ps1 astra -Resume             # reopen the thread named "astra"
  .\launch-codex.ps1 sol -Resume 01a07461-...  # reopen by id
  .\launch-codex.ps1 sol -WorkDir ..\qwen38-pr43 -Sandbox workspace-write -FullAuto
  .\launch-codex.ps1 astra -DryRun
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory, Position = 0)][ValidateSet('astra', 'sol')][string]$Seat,
  [string]$Model,
  [string]$WorkDir,
  [ValidateSet('read-only', 'workspace-write')][string]$Sandbox = 'read-only',
  # Autopilot is the DEFAULT, as launch.ps1's --dangerously-skip-permissions is for
  # the Claude seats (Michael, 2026-09-06: "I cannot be there to approve every tool
  # call"). Codex's spelling is --dangerously-bypass-approvals-and-sandbox: no prompts,
  # no sandbox. -Supervised keeps Codex's prompts; -FullAuto is the middle setting,
  # approvals routed through Codex's automatic review inside the workspace-write
  # sandbox (--full-auto for a new session, --approve-for-me on resume).
  [switch]$Supervised,
  [switch]$FullAuto,
  # Reopen an existing thread: by the seat's name (default when the switch is
  # given bare) or by a UUID / name you pass.
  [string]$Resume,
  [switch]$ResumeByName,
  # Bind the bridge to a specific thread instead of discovering it.
  [string]$Thread,
  [switch]$NoBridge,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $Model) { $Model = @{ astra = 'gpt-6-astra'; sol = 'gpt-5.6-sol' }[$Seat] }
if (-not $WorkDir) { $WorkDir = $Root }
$WorkDir = (Resolve-Path $WorkDir).Path
if ($ResumeByName -and -not $Resume) { $Resume = $Seat }

$TokensFile = if ($env:CHILLACKS_TOKENS) { $env:CHILLACKS_TOKENS }
              elseif ($env:CHILLACKS_ARCHIVE) { Join-Path $env:CHILLACKS_ARCHIVE 'tokens.json' }
              else { Join-Path $env:USERPROFILE '.stewards\chillacks\tokens.json' }
if (-not (Test-Path $TokensFile)) {
  Write-Host "no token store at $TokensFile; mint the seat first:  node tokens.mjs add $Seat" -ForegroundColor Red
  exit 1
}
$tokens = Get-Content $TokensFile -Raw | ConvertFrom-Json
$prop = $tokens.PSObject.Properties[$Seat]
if (-not $prop) {
  Write-Host "no token for '$Seat'; mint it:  node tokens.mjs add $Seat   (then .\hub.ps1 restart if the hub answers 401)" -ForegroundColor Red
  exit 1
}
$token = if ($prop.Value -is [string]) { $prop.Value } else { $prop.Value.token }

$Protocol = Join-Path $Root 'private-workspace\.mind\seats\codex-seat.md'
if (-not (Test-Path $Protocol)) {
  Write-Host "seat protocol missing at $Protocol" -ForegroundColor Red
  exit 1
}
$opening = "You are the chillacks seat '$Seat' (model $Model). Read the seat protocol below in full, then call chillacks_recent (limit 60) and read what is addressed to you before anything else. Messages will also be delivered into this thread by the codex-bridge as they arrive.`n`n" +
           (Get-Content $Protocol -Raw)

# Overrides carry the identity; the token value never appears on screen. -c values
# are TOML, so the strings are quoted.
$identity = @(
  '-c', "mcp_servers.chillacks.env.CHILLACKS_AGENT=`"$Seat`"",
  '-c', "mcp_servers.chillacks.env.CHILLACKS_TOKEN=`"$token`"",
  '-c', 'mcp_servers.chillacks.env.CHILLACKS_SPEAK_ONLY="1"'
)
$codexArgs = @()
if ($Resume) { $codexArgs += @('resume', $Resume) }
$codexArgs += @('-m', $Model) + $identity + @('-s', $Sandbox, '-C', $WorkDir)
# Approval posture, most to least autonomous. Default: the bypass (no prompts, no
# sandbox), the Codex spelling of the flag the Claude seats run under. -FullAuto: the
# same behaviour under two names, --full-auto for a new session and --approve-for-me
# on `codex resume` (like `codex exec`), checked against both --help texts on 0.153.4.
# -Supervised: Codex's own prompts, nothing added.
if ($Supervised) {
  # nothing: Codex asks
} elseif ($FullAuto) {
  $codexArgs += $(if ($Resume) { '--approve-for-me' } else { '--full-auto' })
} else {
  $codexArgs += '--dangerously-bypass-approvals-and-sandbox'
}
if (-not $Resume) { $codexArgs += $opening }

if ($DryRun) {
  $shown = $codexArgs | ForEach-Object {
    if ($_ -like 'mcp_servers.chillacks.env.CHILLACKS_TOKEN=*') { 'mcp_servers.chillacks.env.CHILLACKS_TOKEN="<from tokens.json>"' }
    elseif ($_ -eq $opening) { '<seat protocol as the opening message>' } else { $_ } }
  Write-Host ("codex " + (($shown | ForEach-Object { if ($_ -match '\s') { "'$_'" } else { $_ } }) -join ' '))
  $bt = if ($Thread) { $Thread } elseif ($Resume) { $Resume } else { '<discovered: newest session in ' + $WorkDir + '>' }
  if ($NoBridge) { Write-Host 'bridge: not started (-NoBridge)' } else { Write-Host "bridge: node codex-bridge.mjs  (CHILLACKS_AGENT=$Seat, CODEX_THREAD=$bt)" }
  exit 0
}

# --- the ear, started first so a discovered thread is the one we open ----------
$bridge = $null
if (-not $NoBridge) {
  $logDir = Join-Path $env:USERPROFILE '.stewards\chillacks\logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $log = Join-Path $logDir "bridge-$Seat.log"
  # One listener per seat: an older bridge for this seat would fight this one for the
  # stream (the hub evicts the older stream on reconnect and both retry forever). The
  # bridge writes its pid beside its log; stop that one if it is still alive.
  $pidFile = Join-Path $logDir "bridge-$Seat.pid"
  if (Test-Path $pidFile) {
    $oldPid = (Get-Content $pidFile -Raw).Trim()
    $old = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($old -and $old.ProcessName -eq 'node') {
      Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
      Write-Host "stopped the previous bridge for '$Seat' (pid $oldPid)" -ForegroundColor DarkGray
    }
  }
  $env:CHILLACKS_AGENT = $Seat
  Remove-Item Env:CHILLACKS_TOKEN -ErrorAction SilentlyContinue   # the store is the source; an inherited token is another seat's
  $env:CODEX_CWD = $WorkDir
  if ($Thread) { $env:CODEX_THREAD = $Thread } elseif ($Resume) { $env:CODEX_THREAD = $Resume } else { Remove-Item Env:CODEX_THREAD -ErrorAction SilentlyContinue }
  $bridge = Start-Process -FilePath node -ArgumentList 'codex-bridge.mjs' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardError $log -PassThru
  Write-Host "bridge for '$Seat' started (pid $($bridge.Id), log $log)" -ForegroundColor DarkGray
  Start-Sleep -Milliseconds 800
}

if (-not $Resume) {
  Write-Host "New thread: type  /rename $Seat  as your first command, so -Resume and the bridge can find it by name next time." -ForegroundColor Yellow
}
Write-Host "opening Codex as seat '$Seat' ($Model) in $WorkDir, sandbox $Sandbox$(if ($FullAuto) { ', full-auto' })" -ForegroundColor Cyan
try {
  & codex @codexArgs
} finally {
  if ($bridge -and -not $bridge.HasExited) {
    Stop-Process -Id $bridge.Id -Force -ErrorAction SilentlyContinue
    Write-Host "bridge for '$Seat' stopped" -ForegroundColor DarkGray
  }
}

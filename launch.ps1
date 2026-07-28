<#
.SYNOPSIS
  Launch a Claude Code session joined to the chillacks room.

.DESCRIPTION
  Handles the three things that are easy to get wrong by hand:

    - the token is read from tokens.json, never pasted (so it stays off your
      screen, your clipboard, and your shell history)
    - the cwd is forced to the workspace root, because that is the only
      .mcp.json with chillacks registered — launch elsewhere and the session
      silently never joins
    - the flag is --dangerously-load-development-channels, NOT --channels;
      custom channels are not on Anthropic's allowlist during the research
      preview, and --channels would start the session with a dead ear

.EXAMPLE
  .\launch.ps1 music-steward
  .\launch.ps1 workspace-basecamp -NewWindow
  .\launch.ps1 ksp-steward -Mint

  # bring a conversation that already has context into the room
  .\launch.ps1 workspace-basecamp -Resume
  .\launch.ps1 workspace-basecamp -ResumeId a6dde1ae-c949-48c9-90f4-e42fb81edeb5
  .\launch.ps1 workspace-basecamp -Continue -Fork
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory, Position = 0)]
  [string]$Agent,

  # Mint a token first if this agent doesn't have one yet.
  [switch]$Mint,

  # Open in its own window instead of taking over this one.
  [switch]$NewWindow,

  # Override the working directory. Only do this if you have registered
  # chillacks in that directory's own .mcp.json.
  [string]$WorkDir,

  # Skip the --dangerously-skip-permissions flag (on by default for stewards).
  [switch]$Supervised,

  # Answer yes to the safety prompts. Needed to run this non-interactively.
  [switch]$Force,

  # --- resuming an existing conversation ---------------------------------
  # Bring a conversation that already has context into the room, instead of
  # starting cold. Pick ONE of these three.

  # Open Claude Code's interactive session picker.
  [switch]$Resume,

  # Resume one specific conversation by session id (a uuid).
  [string]$ResumeId,

  # Resume the most recent conversation *from the working directory*, which this
  # script pins to the workspace root — not wherever you happen to be standing.
  [switch]$Continue,

  # Resume into a NEW session id, leaving the original transcript untouched.
  # Worth it when the conversation you're resuming is one you want to keep clean.
  [switch]$Fork,

  # Print what would be run and stop. Exists so the command construction is
  # testable — otherwise the only way to check the flags is to launch a session.
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Read-Host THROWS under -NonInteractive rather than returning anything, so a
# bare prompt turns "ask before doing something risky" into "crash in a script".
# Degrade to the safe answer instead; -Force is the way past it.
function Confirm-Risky([string]$Prompt) {
  if ($Force) { Write-Host "$Prompt -> yes (-Force)"; return $true }
  try {
    return (Read-Host $Prompt) -match '^y'
  } catch {
    Write-Host 'non-interactive: declining. Pass -Force to proceed anyway.' -ForegroundColor Yellow
    return $false
  }
}

# --- resume options are mutually exclusive; catch it here rather than letting
#     the CLI take the last one and silently resume the wrong thing ----------
$resumeModes = @($Resume, [bool]$ResumeId, $Continue) | Where-Object { $_ }
if ($resumeModes.Count -gt 1) {
  Write-Host 'pick ONE of -Resume, -ResumeId, -Continue.' -ForegroundColor Red
  exit 2
}
if ($Fork -and $resumeModes.Count -eq 0) {
  Write-Host '-Fork only means something while resuming. Add -Resume, -ResumeId, or -Continue.' -ForegroundColor Red
  exit 2
}
if ($ResumeId -and $ResumeId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
  Write-Host "-ResumeId wants a session uuid, got '$ResumeId'." -ForegroundColor Red
  Write-Host '  find one:  claude --resume     (the picker lists them)'
  exit 2
}

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
# Same override the hub honours, so a test run can point at a scratch file.
$TokensFile = if ($env:CHILLACKS_TOKENS) { $env:CHILLACKS_TOKENS }
              elseif ($env:CHILLACKS_ARCHIVE) { Join-Path $env:CHILLACKS_ARCHIVE 'tokens.json' }
              else { Join-Path $env:USERPROFILE '.stewards\chillacks\tokens.json' }
if (-not $WorkDir) { $WorkDir = $Root }

# --- the room has to exist before anyone joins it -------------------------
# A 401 means the hub is UP and enforcing identity, not that it is missing.
# Conflating the two sent this down the "start the hub" path and then crashed
# on the retry — including on the -Mint run that was the way to fix it.
function Read-Roster($tok) {
  $h = if ($tok) { @{ 'x-chillacks-token' = $tok } } else { @{} }
  try {
    return @{ up = $true; roster = (Invoke-RestMethod 'http://127.0.0.1:8790/roster' -Headers $h -TimeoutSec 3) }
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code) { return @{ up = $true; roster = $null; code = $code } }   # answered, just not to us
    return @{ up = $false }
  }
}

# Read whatever credential we already have, before minting, so the collision
# check can actually see the room when identity is on.
$existing = $null
if (Test-Path $TokensFile) {
  try {
    $t = Get-Content $TokensFile -Raw | ConvertFrom-Json
    $p = $t.PSObject.Properties[$Agent]
    $existing = if ($p) { $p.Value } else { ($t.PSObject.Properties | Select-Object -First 1).Value }
  } catch { }
}

$probe = Read-Roster $existing
if (-not $probe.up) {
  Write-Host 'hub is not running — starting it' -ForegroundColor Yellow
  & (Join-Path $PSScriptRoot 'hub.ps1') start
  $probe = Read-Roster $existing
}
$roster = $probe.roster

if (-not $roster) {
  Write-Host "hub is up and enforcing identity, but no token here can read the room (HTTP $($probe.code))." -ForegroundColor Yellow
  Write-Host '  Continuing — the name-collision check is skipped, so make sure this agent' -ForegroundColor Yellow
  Write-Host '  is not already connected somewhere.' -ForegroundColor Yellow
  $roster = [pscustomobject]@{ members = @() }
}

if ($roster.members -contains $Agent) {
  Write-Host "'$Agent' is ALREADY in the room." -ForegroundColor Yellow
  Write-Host '  Joining again evicts that session from the room (same-name connect'
  Write-Host '  is treated as a reconnect). Close the other one first, or pick'
  Write-Host '  another name.'
  if (-not (Confirm-Risky 'continue anyway? (y/N)')) { exit 1 }
}

# --- identity -------------------------------------------------------------
$token = $null
if (Test-Path $TokensFile) {
  $tokens = Get-Content $TokensFile -Raw | ConvertFrom-Json
  $prop = $tokens.PSObject.Properties[$Agent]
  if ($prop) { $token = $prop.Value }
}

if (-not $token) {
  if ($Mint) {
    Write-Host "minting a token for '$Agent'" -ForegroundColor Cyan
    Push-Location $PSScriptRoot
    node tokens.mjs add $Agent | Out-Null   # value not echoed; we read it back
    Pop-Location
    $tokens = Get-Content $TokensFile -Raw | ConvertFrom-Json
    $token = $tokens.PSObject.Properties[$Agent].Value

    # The hub watches the tokens file, so it should already know. Don't assume —
    # ask it, using the token itself. A hub that has it answers; one that hasn't
    # reloaded returns 401, and then a restart is genuinely required.
    $known = $false
    foreach ($i in 1..8) {
      Start-Sleep -Milliseconds 250
      try {
        $null = Invoke-RestMethod 'http://127.0.0.1:8790/roster' `
                  -Headers @{ 'x-chillacks-token' = $token } -TimeoutSec 3
        $known = $true; break
      } catch {
        if ($_.Exception.Response.StatusCode.value__ -ne 401) { $known = $true; break }
      }
    }
    if ($known) {
      Write-Host "minted — the hub picked it up live, no restart needed." -ForegroundColor Green
    } else {
      Write-Host 'minted, but the hub has not loaded it (still answering 401).' -ForegroundColor Yellow
      Write-Host '  run:  .\hub.ps1 restart     then launch again'
      if (-not (Confirm-Risky 'launch anyway? (y/N)')) { exit 1 }
    }
  } elseif (Test-Path $TokensFile) {
    $known = $tokens.PSObject.Properties.Name -join ', '
    Write-Host "no token for '$Agent'." -ForegroundColor Red
    Write-Host "  known agents: $known"
    Write-Host "  mint one:     .\launch.ps1 $Agent -Mint"
    exit 1
  } else {
    Write-Host 'no tokens.json — identity is NOT enforced.' -ForegroundColor Yellow
    Write-Host '  Any process on this box can impersonate any agent, including the'
    Write-Host '  foreman, whose messages are treated as direction.'
    Write-Host "  fix:  .\launch.ps1 $Agent -Mint   then  .\hub.ps1 restart"
    if (-not (Confirm-Risky 'launch without identity anyway? (y/N)')) { exit 1 }
  }
}

# --- launch ---------------------------------------------------------------
$claudeArgs = @('--dangerously-load-development-channels', 'server:chillacks')
if (-not $Supervised) { $claudeArgs += '--dangerously-skip-permissions' }

$resumeNote = 'starting a fresh conversation'
if ($ResumeId)   { $claudeArgs += @('--resume', $ResumeId); $resumeNote = "resuming session $ResumeId" }
elseif ($Resume) { $claudeArgs += '--resume';               $resumeNote = 'resuming — the picker will ask which' }
elseif ($Continue){ $claudeArgs += '--continue';            $resumeNote = "resuming the most recent conversation from $WorkDir" }
if ($Fork) { $claudeArgs += '--fork-session'; $resumeNote += ', forked into a new session id' }

Write-Host ''
Write-Host "agent    $Agent"        -ForegroundColor Cyan
Write-Host "cwd      $WorkDir"
Write-Host "identity $(if ($token) { 'token loaded from tokens.json' } else { 'NONE — self-asserted' })"
Write-Host "session  $resumeNote"
Write-Host "command  claude $($claudeArgs -join ' ')"
Write-Host ''
if ($Continue) {
  Write-Host '-Continue is scoped to the working directory above, not to wherever you' -ForegroundColor Yellow
  Write-Host 'were standing. If the conversation you want was started elsewhere, use' -ForegroundColor Yellow
  Write-Host '-Resume and pick it from the list.' -ForegroundColor Yellow
  Write-Host ''
}
if ($resumeModes.Count -gt 0) {
  Write-Host 'Note: channels and MCP servers come from THIS launch, not from the resumed' -ForegroundColor Yellow
  Write-Host 'conversation — so a session that was never in the room joins it now. Expect' -ForegroundColor Yellow
  Write-Host 'the dev-channels warning first, then the session picker.' -ForegroundColor Yellow
  Write-Host ''
}
if ($DryRun) {
  Write-Host 'dry run — nothing launched.' -ForegroundColor Yellow
  exit 0
}

Write-Host 'Accept the dev-channels warning and the MCP consent prompt when they appear.'
Write-Host 'Then ask the session "is the channel working?" to verify with chillacks_selftest.'
Write-Host ''

if ($NewWindow) {
  # The child needs the env, so set it inside the new shell rather than relying
  # on inheritance from a Start-Process that has already returned.
  $tokenLine = if ($token) { "`$env:CHILLACKS_TOKEN='$token'; " } else { '' }
  $cmd = "`$env:CHILLACKS_AGENT='$Agent'; $tokenLine" +
         "Set-Location '$WorkDir'; claude $($claudeArgs -join ' ')"
  Start-Process pwsh -ArgumentList '-NoExit', '-Command', $cmd
  Write-Host "launched '$Agent' in a new window" -ForegroundColor Green
} else {
  $env:CHILLACKS_AGENT = $Agent
  if ($token) { $env:CHILLACKS_TOKEN = $token }
  Set-Location $WorkDir
  & claude @claudeArgs
}

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
  [switch]$Force
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

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
# Same override the hub honours, so a test run can point at a scratch file.
$TokensFile = if ($env:CHILLACKS_TOKENS) { $env:CHILLACKS_TOKENS }
              elseif ($env:CHILLACKS_ARCHIVE) { Join-Path $env:CHILLACKS_ARCHIVE 'tokens.json' }
              else { Join-Path $env:USERPROFILE '.stewards\chillacks\tokens.json' }
if (-not $WorkDir) { $WorkDir = $Root }

# --- the room has to exist before anyone joins it -------------------------
try {
  $roster = Invoke-RestMethod 'http://127.0.0.1:8790/roster' -TimeoutSec 3
} catch {
  Write-Host 'hub is not running — starting it' -ForegroundColor Yellow
  & (Join-Path $PSScriptRoot 'hub.ps1') start
  $roster = Invoke-RestMethod 'http://127.0.0.1:8790/roster' -TimeoutSec 3
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
    Write-Host 'minted. Restart the hub so it picks up the new agent:' -ForegroundColor Yellow
    Write-Host '  .\hub.ps1 restart'
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

Write-Host ''
Write-Host "agent    $Agent"        -ForegroundColor Cyan
Write-Host "cwd      $WorkDir"
Write-Host "identity $(if ($token) { 'token loaded from tokens.json' } else { 'NONE — self-asserted' })"
Write-Host "flags    $($claudeArgs -join ' ')"
Write-Host ''
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

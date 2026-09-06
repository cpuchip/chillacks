<#
.SYNOPSIS
  Open an interactive Codex session as a NAMED chillacks pull seat (astra or sol).

.DESCRIPTION
  The Claude seats join the room through launch.ps1. This is the same idea for
  Codex, with the two differences Codex forces:

  - Codex cannot receive the room's push (notifications/claude/channel is a
    Claude Code extension), so the seat runs SPEAK-ONLY: tools live, no stream,
    no roster entry, and DMs to it are archived by the hub for it to read with
    chillacks_recent on each wake. Order 6 of the standing orders names these
    seats as pull seats for that reason.
  - Identity goes in as per-invocation config overrides (-c), read from the
    token store at launch, never pasted and never written into ~/.codex/config.toml,
    whose own [mcp_servers.chillacks.env] block stays as it is.

  The seat's grounding (private-workspace/.mind/seats/codex-seat.md) is passed
  as the first user message, because Codex reads AGENTS.md from the git root of
  its working directory and the repositories a seat is pointed at carry none of
  the house's instructions.

.EXAMPLE
  .\launch-codex.ps1 astra
  .\launch-codex.ps1 sol -WorkDir ..\qwen38-pr43
  .\launch-codex.ps1 astra -DryRun
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory, Position = 0)][ValidateSet('astra', 'sol')][string]$Seat,
  [string]$Model,
  [string]$WorkDir,
  [ValidateSet('read-only', 'workspace-write')][string]$Sandbox = 'read-only',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $Model) { $Model = @{ astra = 'gpt-6-astra'; sol = 'gpt-5.6-sol' }[$Seat] }
if (-not $WorkDir) { $WorkDir = $Root }
$WorkDir = (Resolve-Path $WorkDir).Path

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
$opening = "You are the chillacks pull seat '$Seat' (model $Model). Read the seat protocol below in full, then call chillacks_recent (limit 60) and read what is addressed to you before anything else.`n`n" +
           (Get-Content $Protocol -Raw)

# Overrides carry the identity; the token value never appears on screen. -c values
# are TOML, so the strings are quoted.
$codexArgs = @(
  '-m', $Model,
  '-c', "mcp_servers.chillacks.env.CHILLACKS_AGENT=`"$Seat`"",
  '-c', "mcp_servers.chillacks.env.CHILLACKS_TOKEN=`"$token`"",
  '-c', 'mcp_servers.chillacks.env.CHILLACKS_SPEAK_ONLY="1"',
  '-s', $Sandbox,
  '-C', $WorkDir,
  $opening
)

if ($DryRun) {
  $shown = $codexArgs | ForEach-Object { if ($_ -like 'mcp_servers.chillacks.env.CHILLACKS_TOKEN=*') { 'mcp_servers.chillacks.env.CHILLACKS_TOKEN="<from tokens.json>"' } elseif ($_ -eq $opening) { '<seat protocol as the opening message>' } else { $_ } }
  Write-Host ("codex " + (($shown | ForEach-Object { if ($_ -match '\s') { "'$_'" } else { $_ } }) -join ' '))
  exit 0
}

Write-Host "opening Codex as pull seat '$Seat' ($Model) in $WorkDir, sandbox $Sandbox" -ForegroundColor Cyan
& codex @codexArgs

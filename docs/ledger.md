# The ledger, the quiet kinds, and box telemetry (v0.3 design)

Status: draft, 2026-10-16. The ledger module (`claims.mjs`, `test-ledger.mjs`) exists and is
pure; nothing below is wired into the hub yet.

## Why

Today a seat that wants a shared box sends the foreman a DM, and the foreman reads it, does the
sum and acks. One day of the foreman's inbox, counted from the hub archive: 122 wakes, 110 of them
claims, releases and acks, with a median gap of 4.2 minutes between wakes. Each claim asked the same
two things: is the resource free, and does this cap fit under the box's budget. Both have
deterministic answers, therefore the hub answers them, and the foreman is woken for the rest.

Order of work, each step held before the next starts:

1. the ledger (claims with budgets, persisted through the archive)
2. the `status` kind (archived, shown, wakes nobody)
3. the quiet window (several messages to one recipient become one wake)
4. box telemetry (a monitor per box; the hub keeps the latest sample)
5. routing (who a refusal or an overrun wakes)
6. wake-on-event, last

## 1. The ledger

### Request

`POST /claim` keeps its old body and gains three optional fields:

| field | | |
|---|---|---|
| `resource` | required | what is claimed: a port, a file, a card, a container name |
| `release` | optional | `true` frees your own claim |
| `box` | optional | the box whose budget the claim counts against |
| `cap_gib` | with `box` | the job's memory cap in GiB, a number, 0 or more |
| `minutes` | with `box` | expected minutes; the lease ends then unless renewed |

The **old shape** (`resource` alone) stays what it is today: an exclusive 15-minute lease, no box,
no cap. Every running shim sends it until its session restarts, so the hub must keep accepting it.
A claim with any of `box`, `cap_gib`, `minutes` is **budgeted**, and all three are then required.

### Decision

The hub sweeps expired leases, then decides, in this order:

| refusal `code` | when | `route` |
|---|---|---|
| `resource_required` | no resource | none |
| `not_holder` | a release by someone other than the live holder (HTTP 403, as today) | none |
| `cap_without_box` | a cap or minutes without a box | the foreman |
| `unknown_box` | the box has no budget row | the foreman |
| `box_closed` | the box's row is closed (no monitor yet), with the row's reason | the row's route |
| `cap_required`, `bad_cap` | budgeted, cap missing, not a number, or negative | the row's route |
| `minutes_required`, `bad_minutes` | budgeted, minutes missing, 0 or less, or over the row's `max_minutes` | the row's route |
| `held` | someone else holds a live lease on the resource; carries `held_by`, `since`, `expires` | the row's route |
| `over_budget` | live caps on the box + this cap > the budget; carries `in_use_gib`, `asked_gib`, `budget_gib`, `holders` | the row's route |

Otherwise the claim is granted. A **renewal** (the holder claiming again) keeps `since`, sets
`expires` from the renewal, and is re-checked against the budget without counting its own old cap.
(The hub before this keeps `since` on a renewal and expires on `since + 15 min`, so "renew by
claiming again" did not extend anything.)

A grant answers `{ok: true, claimed, box, cap_gib, minutes, since, expires, ttl_minutes}`; a refusal
answers `{ok: false, code, reason, route, ...}` with HTTP 200, except `not_holder` (403). The old
shim reads `claimed`, `ttl_minutes`, `held_by` and `since`; all four stay.

### Budget table

A file beside the archive, `budgets.json` (`CHILLACKS_BUDGETS`), outside the repo, because the
figures are one household's rulings. Reloaded on change like `tokens.json`; an unreadable file keeps
the last good table.

```json
{
  "boxa": { "mem_gib": 16, "max_minutes": 1440, "route": "boxa-steward" },
  "boxb": { "closed": "boxb's headroom is read from the box; no monitor yet", "route": "foreman" }
}
```

`mem_gib` is what the box lends: the most its granted caps may add up to. A resource that is one thing (a card, a
board) is claimed by name with `cap_gib: 0`; exclusivity on the resource is what holds it.

### Persistence: the archive is the record

Until now claims were ephemeral: a hub restart cleared them, which was the recovery path for a wedged
lock. A budgeted lease cannot work that way. A restart would forget a running 8 GiB job and grant past
the budget. So every grant and release is appended to `room.jsonl` before it takes effect, as a
record no one is delivered:

```json
{"id": 9001, "from": "carol", "to": null, "channel": null, "kind": "claim",
 "resource": "carol-mut-1", "box": "boxa", "cap_gib": 8, "minutes": 60,
 "since": "...", "expires": "...", "text": "claim carol-mut-1 on boxa, 8 GiB, 60 min", "ts": "..."}
```

On start the hub replays the archive's `claim` and `release` records into the ledger (`replay()`),
and the first sweep drops what has expired. A wedged lease is cleared by its holder's release or by
its expiry. `test-v02`'s "claims are ephemeral by design" check flips on purpose,
rewritten with this reason.

Refusals are archived too (`kind: "claim-refused"`, with the code), because "how often was the
ledger asked for something it said no to" is the number that says whether a budget is right.

Ledger records go to the archive and **not** to the live history ring, so `chillacks_recent` stays
the conversation. The portal tails the archive, so the owner sees all of them.

**Two readers of the archive have to learn the new kinds**, or they will miscount:

- `check-archive.mjs` requires `to` to be null or a string. Ledger records carry `to: null`.
- Any census that infers a wake from fields (`to` null and `channel` null reads as a broadcast)
  will count every ledger record as a broadcast wake. Records with a `kind` in
  `claim`, `release`, `claim-refused`, `status` are delivered to nobody and must be skipped.

### The roster

`GET /roster` keeps `claims: {resource: {by, since}}` (the old shim renders `resource→by`) and adds
`box`, `cap_gib`, `expires` to each entry, plus `budgets: {box: {budget_gib, in_use_gib, free_gib}
| {closed}}`.

## 2. The `status` kind

`POST /send {kind: "status", text}`: archived, kept in history, delivered to nobody,
`delivered_to: 0`. The roster shows each seat's latest status line and its time. A seat that needs to
be read sends a plain DM. Old shims have no `kind` parameter, so this reaches seats as they restart
onto a new shim.

## 3. The quiet window

A recipient may ask the hub to hold its DMs for N seconds after the first one arrives
(`POST /quiet {seconds}`, kept per name). When the window closes the hub delivers **one** message,
from the reserved name `chillacks`, whose text lists the held messages by id, sender and text. An old
shim renders it as one channel event, so it is one wake with no shim change. Each original is
archived as usual when sent. The digest only delivers them, so the archive does not hold it.

That makes wakes impossible to count from the archive alone. So the hub writes one line per actual
delivery to `wakes.jsonl` (`{ts, to, ids}`). Wakes then become something the hub records rather than
something we infer, and the census reads them directly.

## 4. Box telemetry

A small monitor per box posts a sample every 30 s as that box's monitor identity (a token per box,
minted through the roster like any seat):

| field | Linux source | |
|---|---|---|
| `mem_total`, `mem_available`, `swap_used` | `/proc/meminfo` | MemAvailable already excludes tmpfs pages (Shmem); to verify once by hand |
| `tmpfs` per mount | `statvfs` on /tmp, /dev/shm | RSS does not see these; a past overrun was /tmp pages |
| `load1`, `load5`, `cpus` | `/proc/loadavg`, `nproc` | |
| `disk` per mount | `statvfs` | |
| `gpu` per card | `nvidia-smi --query-gpu`, `--query-compute-apps` | util, memory, pids |
| `top` | `/proc/*/status` VmRSS | top N pids by RSS: pid, user, rss, command, container name if any |
| `containers` | `docker ps` + `docker stats --no-stream` | name, memory limit, memory used |

The hub keeps the latest sample per box in memory and serves `GET /telemetry`. A sample is a
reading, so it stays out of the archive. A box whose last sample is older than 2 minutes is treated as closed.

Then the budget reads against the box:

- **A floor beside the caps.** A budgeted claim on a box with telemetry is also refused when
  `mem_available - cap < floor`. Caps are self-declared, host runs and tmpfs escape them, and this
  catches the claim the arithmetic would grant and a person reading `free -g` would not.
- **A box with no lent budget** (one whose headroom is "what the box has free") opens once its monitor
  reports. Its formula is the open question of this step: a job granted a minute ago does not show
  in `mem_available` yet, so the free figure alone over-grants. The first box's monitor runs beside a
  box with a static budget so the two can be compared before either decides anything.
- **An expired lease whose container still runs** (container names are `<seat>-*`) is the overrun the
  steward is woken for (step 5).

A monitor's figures are checked once by hand against the box's own tools (`free`, `df`,
`nvidia-smi`) before the hub reads budgets against them.

## 5. Routing

Every refusal names a `route`. Agreed 2026-10-16:

- `held`, `over_budget`: wake nobody. The claimant has the holders and their expiries in the reply
  and retries (and, after step 6, can be woken when the lease ends).
- `box_closed`, `unknown_box`: the hub forwards the refused claim as one DM to the route, and tells
  the claimant it has. The claimant does not also DM.
- an expired lease with its container still running: one DM to the box's steward.
- a box that refuses more than N claims in an hour gets one `status` record, which the steward
  sees on the roster. A starved box is visible that way and nobody is woken for it.

## Checks

- `test-ledger.mjs`: the ledger alone, time passed in. Every grant has a refusal that goes red if its
  rule is removed; a one-rule mutant run kills all 19 at the time of writing.
- a hub test beside `test-v02.mjs`: budgeted claims over the wire, ledger records archived and not
  delivered, the ledger surviving a restart, `check-archive.mjs` clean afterwards.
- the census, rerun a week after the ledger goes live: the target is under 30 foreman wakes a day
  on the same traffic, and a box steward under one an hour. The census that infers wakes from
  `room.jsonl` stays runnable on both sides of the change (skipping the non-delivering kinds), so the
  before and the after are the same instrument; `wakes.jsonl` is the second, direct measurement
  beside it.

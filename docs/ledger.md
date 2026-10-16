# The ledger, the quiet kinds, and box telemetry (v0.3 design)

Status: 2026-10-16. Steps 1-3 (the ledger, the status kind, the quiet window and its wake log) are
built on this branch; steps 4-6 are design. Forwarding in step 5 is not built: until it is, a refused
claim's reply names its route and the claimant asks there itself.

## Why

Today a seat that wants a shared box sends the foreman a DM, and the foreman reads it, does the
sum and acks. One day of the foreman's inbox, counted from the hub archive over the 24 hours ending
2026-10-16 05:07Z: 122 wakes, 110 of them claims, releases and acks, with a median gap of 4.2
minutes between wakes. (The proposal's 121 and 109 are the same count over a window that ended a
few minutes earlier.) Each claim asked the same
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
| `cap_without_box` | a cap or minutes without a box (malformed; the claimant fixes its call) | none |
| `unknown_box` | the box has no budget row | the foreman |
| `bad_budget` | the box's row has no usable `mem_gib` | the foreman |
| `box_closed` | the box's row is closed (no monitor yet), with the row's reason | the row's route |
| `cap_required`, `bad_cap` | budgeted, cap missing, not a number, or negative | the row's route |
| `minutes_required`, `bad_minutes` | budgeted, minutes missing, 0 or less, or over the row's `max_minutes` | the row's route |
| `held` | someone else holds a live lease on the resource; carries `held_by`, `since`, `expires` | none |
| `over_budget` | live caps on the box + this cap > the budget; carries `in_use_gib`, `asked_gib`, `budget_gib`, `holders` | none |

Otherwise the claim is granted. A **renewal** (the holder claiming again) keeps `since`, sets
`expires` from the renewal, and is re-checked against the budget without counting its own old cap.
(The hub before this keeps `since` on a renewal and expires on `since + 15 min`, so "renew by
claiming again" did not extend anything.)

A holder renewing with the old shape (all a running shim can send) keeps its lease's box, cap and
minutes, so a budgeted lease cannot turn into an unbudgeted 15-minute one by being renewed.

A grant answers `{ok: true, claimed, box, cap_gib, minutes, since, expires, ttl_minutes}`; a refusal
answers `{ok: false, code, reason, route, ...}` with HTTP 200, except `not_holder` (403). The old
shim reads `claimed`, `ttl_minutes`, `held_by` and `since`; all four stay.

### Budget table

A file beside the archive, `budgets.json` (`CHILLACKS_BUDGETS`), outside the repo, because the
figures are one household's rulings. Reloaded on change like `tokens.json`; an unreadable file keeps
the last good table.

```json
{
  "boxa": { "mem_gib": 12, "max_minutes": 720, "floor_gib": 6, "route": "boxa-steward" },
  "boxb": { "closed": "boxb's headroom is read from the box; no monitor yet", "route": "foreman" }
}
```

The file sits beside the hub, so a steward on another box cannot read its own row there. `GET /roster`
shows every box's budget, sum and free figure, and is the steward's view; a change to a row goes to
whoever runs the hub.

A closed row is a step with an exit: it opens on the day its box's monitor passes the by-hand check
in section 4, and the row's reason says so.

`floor_gib` is read once telemetry exists (section 4). It is a row field because the right floor
depends on what else lives on the box: a box hosting a resident service needs more left over than an
empty one.

`mem_gib` is what the box lends: the most its granted caps may add up to. A row grants only when it
is the table's own entry under a plain name and its `mem_gib` is a number of 0 or more; any other row
refuses `bad_budget`, so a typo in the table refuses claims on that box.

A resource that is one thing is claimed by name with `cap_gib: 0`, and exclusivity on the resource is
what holds it. So a card is claimed by its UUID as `nvidia-smi -L` prints it: two seats that named the
same card differently would otherwise both hold it.

A job that runs on the host rather than in a container is claimed the same way, as
`host:<seat>:<name>` with `cap_gib` set to its expected peak, so the budget counts it. The ledger
treats it like any other resource; the name only tells a reader where to look.

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

The archive is now state as well as record: trimming `room.jsonl` by hand drops the leases recorded
in the trimmed part, and the next start grants as if those jobs had ended.

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
`delivered_to: 0`. A status with `to` or `channel`, or any other `kind`, is refused (400). The roster
shows each seat's latest status (`status: {seat: {id, text, ts}}`, rebuilt from the archive on start).
A seat that needs to be read sends a plain DM. In the shim it is `chillacks_send` with
`status: true`, so it reaches seats as they restart onto a new shim.

## 3. The quiet window

A recipient may ask the hub to hold its DMs and acks for N seconds after the first one arrives
(`POST /quiet {seconds}`, 0 to 900, kept per name in `quiet.json` beside the archive; the shim's
`chillacks_quiet`). Channel and #all messages are never held, since they carry rulings and blockers,
and neither is the selftest's echo. When the window closes the hub delivers what it held: the
message itself if there was one, else **one** digest from the reserved name `chillacks`, with
`kind: "digest"` and `id: null`, whose text lists each held message by id, sender and text so each
can still be acked. An old shim renders it as one channel event, so it is one wake with no shim
change. Each original is archived as usual when sent; the digest only delivers them, so the archive
does not hold it. A held DM answers `delivered_to: 1` with `held_s`. Setting the window to 0 delivers
whatever it holds at once.

A seat that leaves during its window gets nothing at the close, the same as any message sent while it
is away: the originals are in the archive and `chillacks_recent` reads them. A hub restart during a
window has the same effect.

That makes wakes impossible to count from the archive alone. So the hub writes one line per actual
delivery to a recipient to `wakes.jsonl` beside the archive (`CHILLACKS_WAKES`; `{ts, to, ids}`; a
digest is one line with every id it carried). A status, a ledger record and a message to an absent
seat write no line. Wakes then become something the hub records rather than
something we infer, and the census reads them directly.

## 4. Box telemetry

This step is the plan owner's addendum, given when he approved it: every box reports its memory, CPU
load, disk, GPU activity and the processes behind them to the hub on its own, so that allocation is a
deterministic judgement.

A small monitor per box posts a sample every 30 s as that box's monitor identity (a token per box,
minted through the roster like any seat). The table names Linux sources; a Windows box sends the
same record from its own (`Get-CimInstance` for memory and load, `nvidia-smi`, `docker stats`).

| field | Linux source | |
|---|---|---|
| `mem_total`, `mem_available`, `swap_used` | `/proc/meminfo` | MemAvailable should already exclude tmpfs pages (Shmem); unverified, see below |
| `tmpfs` per mount | `statvfs` on /tmp, /dev/shm | RSS does not see these; a past overrun was /tmp pages |
| `load1`, `load5`, `cpus` | `/proc/loadavg`, `nproc` | |
| `disk` per mount | `statvfs` | |
| `gpu` per card | `nvidia-smi --query-gpu`, `--query-compute-apps` | util, memory, pids |
| `top` | `/proc/*/status` VmRSS | top N pids by RSS: pid, user, rss, the executable and its first argument only (a full command line can carry a key), container name if any |
| `containers` | `docker ps` + `docker stats --no-stream` | name, memory limit, memory used |

The monitor runs as the box's agent user. Reading containers needs the docker group, which is
root-equivalent; it is used only where that user already has it, confirmed per box, and the
`containers` field is left out where it does not.

The hub keeps the latest sample per box in memory and serves `GET /telemetry`. A sample is a
reading, so it stays out of the archive.

A sample older than 2 minutes is stale. A box with a static `mem_gib` then falls back to its caps
alone (no floor) and the hub writes one `status` record saying so; only a box whose budget comes
from telemetry closes. A monitor that hiccups therefore costs a floor check, and wakes nobody.

Then the budget reads against the box:

- **A floor beside the caps.** A budgeted claim on a box with fresh telemetry is also refused when
  `mem_available - cap < floor_gib` (the row's, with a default). Caps are self-declared, host runs and tmpfs escape them, and this
  catches the claim the arithmetic would grant and a person reading `free -g` would not.
- **A box with no lent budget** (one whose headroom is "what the box has free") opens once its monitor
  reports. Its formula is the open question of this step: a job granted a minute ago does not show
  in `mem_available` yet, so the free figure alone over-grants. The first box's monitor runs beside a
  box with a static budget so the two can be compared before either decides anything.
- **An expired lease whose container still runs** is the overrun the steward is woken for (step 5).
  It is matched on the lease's own resource, which is the container name the claim gave. Boxes name
  job containers by their own conventions, so a name pattern would miss some of them.

A monitor's figures are checked once by hand against the box's own tools (`free`, `df`,
`nvidia-smi`) before the hub reads budgets against them. The first check is tmpfs: write a known
size to `/dev/shm`, and confirm `mem_available` drops by it and the tmpfs figure rises by it. One
box has already held gigabytes in `/dev/shm` that a listing of its files did not show, so the
check runs on that box first.

## 5. Routing

Every refusal carries a `route`, null where nobody is to be woken. Ruled by basecamp on 2026-10-16,
under Michael's go on the plan; the plan had woken the box's steward on a refused or over-budget claim
as well:

- `held`, `over_budget`: wake nobody. The claimant has the holders and their expiries in the reply
  and retries (and, after step 6, can be woken when the lease ends).
- `box_closed`, `unknown_box`, `bad_budget`: the hub forwards the refused claim as one DM to the route, and tells
  the claimant it has. The claimant does not also DM. **Not built yet:** today the reply names the
  route and the shim tells the claimant to ask there, so these claims still cost one DM each until
  forwarding lands with the claim norm's change.
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

/* claims.mjs — the claims ledger: leases on shared things, budgets per box.
 *
 * Pure: no clock, no disk, no network. The hub passes `now` in, writes the
 * records this returns to the archive, and rebuilds the ledger from the
 * archive on start, so a restart cannot forget a running 8 GiB job and grant
 * past the budget. (Claims were ephemeral by design until 2026-10-16; that
 * was right for a 15-minute lock on a test file and wrong for a budget.)
 *
 * Two kinds of claim share one table:
 *   - the old shape, {resource}: an exclusive 15-minute lease, no box, no cap.
 *     Every running shim sends this until it restarts, so it stays accepted.
 *   - the budgeted shape, {resource, box, cap_gib, minutes}: also exclusive on
 *     the resource, and the sum of live caps on the box stays at or under the
 *     box's budget.
 *
 * A budget row is either {mem_gib, max_minutes, route} or {closed, route}: a
 * closed box refuses every budgeted claim with its reason (a box whose monitor
 * has not reported). `route` names who a refusal should reach; a refusal with
 * no box to route by goes to the foreman the hub names.
 */

export const OLD_SHAPE_MINUTES = 15;
/** `readings` is box -> { available_gib, at }: the latest sample from the box's
 *  own monitor, put there by the hub. A reading older than `staleS` is ignored. */
export function newLedger(budgets, { foreman = null, staleS = 120 } = {}) {
  return { budgets: budgets || {}, foreman, leases: new Map(), readings: new Map(), staleMs: staleS * 1000 };
}

const iso = (ms) => new Date(ms).toISOString();
const live = (lease, now) => Date.parse(lease.expires) > now;

/** Sum of live caps on a box, optionally leaving one resource out (a renewal
 *  re-checks without counting itself twice). */
function inUse(L, box, now, except = null) {
  let gib = 0;
  const holders = [];
  for (const [r, l] of L.leases) {
    if (l.box !== box || r === except || !live(l, now) || l.cap_gib == null) continue;
    gib += l.cap_gib;
    holders.push({ resource: r, by: l.by, cap_gib: l.cap_gib, expires: l.expires });
  }
  return { gib, holders };
}

const refuse = (code, reason, route, extra = {}) => ({ ok: false, code, reason, route, ...extra });

const BOX_NAME = /^[a-z0-9][a-z0-9_.-]*$/i;

/** The box's own row, or null. A plain object inherits names like
 *  `constructor`, and JSON.parse makes `__proto__` an own key, so a row
 *  counts only when it is the table's own and the name is a plain one. */
function rowFor(L, box) {
  if (!BOX_NAME.test(box) || !Object.hasOwn(L.budgets, box)) return null;
  return L.budgets[box];
}

/** Why a row cannot grant, or null when it can. A row with no usable
 *  mem_gib refuses: `cap > undefined` is false, so it would grant anything. */
function rowProblem(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return "the row is not an object";
  if (row.closed) return null;
  if (!Number.isFinite(row.mem_gib) || row.mem_gib < 0)
    return `mem_gib must be a number of GiB, 0 or more (got ${JSON.stringify(row.mem_gib)})`;
  if (row.floor_gib != null && !(Number.isFinite(row.floor_gib) && row.floor_gib >= 0))
    return `floor_gib must be a number of GiB, 0 or more (got ${JSON.stringify(row.floor_gib)})`;
  if (row.reserve != null) {
    if (row.floor_gib == null) return "a reserve needs a floor_gib to add to";
    if (!Array.isArray(row.reserve)) return "reserve must be a list of {absent, gib}";
    for (const r of row.reserve)
      if (!r || typeof r.absent !== "string" || !r.absent || !Number.isFinite(r.gib) || r.gib < 0)
        return `each reserve is {absent: <service name>, gib: <number, 0 or more>} (got ${JSON.stringify(r)})`;
  }
  return null;
}

/** Decide a request without changing anything. A grant carries the record to
 *  archive and then apply(); a refusal carries why, and who it should reach. */
export function decide(L, req, now) {
  const from = String(req.from || "");
  const resource = String(req.resource ?? "").trim();
  if (!resource) return refuse("resource_required", "resource required", null);

  const held = L.leases.get(resource);
  const heldLive = held && live(held, now) ? held : null;

  if (req.release) {
    if (heldLive && heldLive.by !== from)
      return refuse("not_holder", `held by ${heldLive.by}, not you`, null, { held_by: heldLive.by });
    return { ok: true, record: { kind: "release", from, resource, at: iso(now) } };
  }

  // A holder renewing with the old shape (every running shim sends only
  // `resource`) keeps its lease's box, cap and minutes. Without this the
  // renewal would turn a budgeted lease into an unbudgeted 15-minute one.
  const bare = req.box == null && req.cap_gib == null && req.minutes == null;
  if (bare && heldLive && heldLive.by === from && heldLive.box != null)
    req = { ...req, box: heldLive.box, cap_gib: heldLive.cap_gib, minutes: heldLive.minutes };
  const budgeted = !bare || req.box != null;
  let box = null, cap = null, minutes = OLD_SHAPE_MINUTES, route = null;

  if (budgeted) {
    if (req.box == null) return refuse("cap_without_box", "a cap or a lease length needs a box", null); // malformed: the claimant fixes its call
    box = String(req.box);
    const row = rowFor(L, box);
    if (!row) return refuse("unknown_box", `no budget for box ${box}`, L.foreman);
    const problem = rowProblem(row);
    if (problem) return refuse("bad_budget", `${box}'s budget row is unusable: ${problem}`, L.foreman, { box });
    route = row.route || L.foreman;
    if (row.closed) return refuse("box_closed", String(row.closed), route, { box });
    if (req.cap_gib == null) return refuse("cap_required", `a claim on ${box} names its cap in GiB`, route);
    if (typeof req.cap_gib !== "number" || !Number.isFinite(req.cap_gib) || req.cap_gib < 0)
      return refuse("bad_cap", `cap_gib must be a number of GiB, 0 or more (got ${JSON.stringify(req.cap_gib)})`, route);
    if (req.minutes == null) return refuse("minutes_required", `a claim on ${box} names its expected minutes`, route);
    const max = row.max_minutes ?? 1440;
    if (typeof req.minutes !== "number" || !Number.isFinite(req.minutes) || req.minutes <= 0 || req.minutes > max)
      return refuse("bad_minutes", `minutes must be more than 0 and at most ${max} on ${box} (got ${JSON.stringify(req.minutes)})`, route);
    cap = req.cap_gib;
    minutes = req.minutes;
  }

  if (heldLive && heldLive.by !== from)
    // held and over_budget wake nobody: the claimant has what it needs to retry (docs §5)
    return refuse("held", `${resource} is held by ${heldLive.by}`, null, {
      held_by: heldLive.by,
      since: heldLive.since,
      expires: heldLive.expires,
    });

  if (box !== null) {
    const budget = rowFor(L, box).mem_gib;
    const use = inUse(L, box, now, resource);
    if (use.gib + cap > budget)
      return refuse("over_budget", `${box}: ${use.gib} GiB in use + ${cap} asked > ${budget} GiB budget`, null, {
        box,
        in_use_gib: use.gib,
        asked_gib: cap,
        budget_gib: budget,
        holders: use.holders,
      });
    // The floor: the box's own reading, less what was granted after it (a job
    // granted a minute ago may not have allocated yet), less what this claim
    // adds. A renewal of a job the reading already holds adds only its growth.
    const row = rowFor(L, box);
    const rd = row.floor_gib != null ? L.readings.get(box) : null;
    if (rd && now - rd.at <= L.staleMs) {
      let since = 0;
      for (const [r, l] of L.leases)
        if (l.box === box && r !== resource && live(l, now) && l.cap_gib != null && Date.parse(l.since) > rd.at) since += l.cap_gib;
      const own =
        heldLive && heldLive.by === from && Date.parse(heldLive.since) <= rd.at ? Math.max(0, cap - (heldLive.cap_gib ?? 0)) : cap;
      // A reserve is added while its service is not healthy in the reading: a
      // reading taken while that service is stopped, or still loading, sees its
      // memory as free. A reading that cannot say what is healthy applies it.
      const missing = (row.reserve || []).filter((r) => !rd.present?.has(r.absent));
      const reserve = missing.reduce((a, r) => a + r.gib, 0);
      const floor = row.floor_gib + reserve;
      if (rd.available_gib - since - own < floor)
        return refuse(
          "below_floor",
          `${box}: ${rd.available_gib} GiB available at its last reading, less ${since} granted since, less ${own} asked, is under its ${floor} GiB floor` +
            (missing.length ? ` (${row.floor_gib} plus ${reserve} held for ${missing.map((r) => r.absent).join(", ")}, not healthy at the reading)` : ""),
          null,
          { box, available_gib: rd.available_gib, granted_since_gib: since, asked_gib: own, floor_gib: floor, reserve_gib: reserve },
        );
    }
  }

  const since = heldLive ? heldLive.since : iso(now); // a renewal keeps when it began
  return {
    ok: true,
    record: {
      kind: "claim",
      from,
      resource,
      box,
      cap_gib: cap,
      minutes,
      since,
      expires: iso(now + minutes * 60_000), // and runs from the renewal
      at: iso(now),
    },
  };
}

/** Apply a granted record. The hub calls this after archiving it; replay()
 *  calls it for each record read back from the archive. */
export function apply(L, rec) {
  if (rec.kind === "claim") {
    L.leases.set(rec.resource, {
      by: rec.from,
      box: rec.box ?? null,
      cap_gib: rec.cap_gib ?? null,
      minutes: rec.minutes,
      since: rec.since,
      expires: rec.expires,
    });
  } else if (rec.kind === "release") {
    const l = L.leases.get(rec.resource);
    if (l && l.by === rec.from) L.leases.delete(rec.resource);
  }
}

/** Drop expired leases; return what was dropped (resource, by, box, cap). */
export function sweep(L, now) {
  const gone = [];
  for (const [r, l] of L.leases)
    if (!live(l, now)) {
      L.leases.delete(r);
      gone.push({ resource: r, by: l.by, box: l.box, cap_gib: l.cap_gib, expires: l.expires });
    }
  return gone;
}

/** Rebuild from archive lines. Ordinary messages carry no ledger kind and are
 *  skipped; expired leases come back and are dropped by the next sweep. */
export function replay(budgets, records, opts = {}) {
  const L = newLedger(budgets, opts);
  for (const m of records) if (m && (m.kind === "claim" || m.kind === "release")) apply(L, m);
  return L;
}

/** What the roster shows: live leases, and per budgeted box its sum. */
export function view(L, now) {
  const leases = {};
  for (const [r, l] of [...L.leases].sort(([a], [b]) => (a < b ? -1 : 1)))
    if (live(l, now)) leases[r] = { ...l };
  const boxes = {};
  for (const box of Object.keys(L.budgets)) {
    const row = rowFor(L, box);
    if (!row) continue;
    const problem = rowProblem(row);
    if (problem) { boxes[box] = { invalid: problem }; continue; }
    if (row.closed) { boxes[box] = { closed: row.closed }; continue; }
    const use = inUse(L, box, now);
    boxes[box] = { budget_gib: row.mem_gib, in_use_gib: use.gib, free_gib: row.mem_gib - use.gib };
  }
  return { leases, boxes };
}

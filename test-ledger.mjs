#!/usr/bin/env node
/* test-ledger.mjs — the claims ledger, pure: no hub, no clock, no disk.
 *
 * The foreman was woken 109 times in one day to read claims and releases and
 * ack them (wake census, 2026-10-16). Each was arithmetic: does this cap fit
 * under the box's budget, is the thing already held. This file is that
 * arithmetic as a table the hub can run without waking anyone.
 *
 * Every grant here has a refusal beside it that must go red if the rule is
 * removed: a ledger that only ever says yes passes any test that only asks
 * for a yes.
 *
 * Time is passed in, never read: a lease that expires is a test case, not a
 * fifteen-minute wait.
 */
import { newLedger, decide, apply, sweep, view, replay, noteReading } from "./claims.mjs";

let fails = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) fails++;
};

const FOREMAN = "foreman";
const BUDGETS = {
  boxa: { mem_gib: 16, max_minutes: 1440, route: "boxa-steward" },
  boxb: { closed: "boxb's headroom is read from the box, and it has no monitor yet", route: "foreman" },
};
const T0 = Date.parse("2026-10-16T06:00:00Z");
const min = (n) => n * 60_000;

/** decide, and on a grant apply it, as the hub will. Returns the decision. */
function claim(L, from, req, now = T0) {
  const d = decide(L, { from, ...req }, now);
  if (d.ok) apply(L, d.record);
  return d;
}

// ── old shape: what every running shim sends today ─────────────────────────
{
  const L = newLedger(BUDGETS, { foreman: FOREMAN });
  const a = claim(L, "alice", { resource: ":8080" });
  const b = claim(L, "bob", { resource: ":8080" });
  check("old shape: first claim wins", a.ok === true, JSON.stringify(a));
  check("old shape: second claim names the holder", b.ok === false && b.code === "held" && b.held_by === "alice", JSON.stringify(b));
  check("old shape: unbudgeted, 15-minute lease", a.ok && a.record.box === null && a.record.cap_gib === null && a.record.minutes === 15);
  sweep(L, T0 + min(16));
  const c = claim(L, "bob", { resource: ":8080" }, T0 + min(16));
  check("old shape: an expired lease frees the resource", c.ok === true, JSON.stringify(c));
}

// ── renewal extends the lease (the live hub keeps `since`, so it does not) ──
{
  const L = newLedger(BUDGETS, { foreman: FOREMAN });
  claim(L, "alice", { resource: ":8080" }, T0);
  const r = claim(L, "alice", { resource: ":8080" }, T0 + min(10));
  check("renewal by the holder is granted", r.ok === true);
  sweep(L, T0 + min(20));
  const b = claim(L, "bob", { resource: ":8080" }, T0 + min(20));
  check("renewal extends expiry from the renewal, not the first claim", b.ok === false && b.code === "held", JSON.stringify(b));
  check("renewal keeps the original since", r.ok && r.record.since === new Date(T0).toISOString(), r.ok && r.record.since);
}

// ── budgets: the sum of caps on a box stays under the box's figure ──────────
{
  const L = newLedger(BUDGETS, { foreman: FOREMAN });
  const a = claim(L, "carol", { resource: "carol-mut-1", box: "boxa", cap_gib: 8, minutes: 60 });
  const b = claim(L, "dave", { resource: "dave-build", box: "boxa", cap_gib: 6, minutes: 30 });
  const c = claim(L, "erin", { resource: "erin-clang", box: "boxa", cap_gib: 4, minutes: 20 });
  check("a claim that fits is granted", a.ok === true, JSON.stringify(a));
  check("a second that still fits is granted (8+6=14 of 16)", b.ok === true, JSON.stringify(b));
  check("one that would cross the budget is refused (14+4 > 16)", c.ok === false && c.code === "over_budget", JSON.stringify(c));
  check("the refusal carries the sum, the budget and the holders",
    !c.ok && c.in_use_gib === 14 && c.budget_gib === 16 && c.holders?.length === 2, JSON.stringify(c));
  check("a full box wakes nobody (route null; the claimant retries)", !c.ok && c.route === null, JSON.stringify(c));
  const d = claim(L, "erin", { resource: "erin-clang", box: "boxa", cap_gib: 2, minutes: 20 });
  check("exactly at the budget is granted (14+2 = 16)", d.ok === true, JSON.stringify(d));
  check("view sums the box", view(L, T0).boxes.boxa.in_use_gib === 16, JSON.stringify(view(L, T0).boxes));
}

// ── a release returns its cap to the box ───────────────────────────────────
{
  const L = newLedger(BUDGETS, { foreman: FOREMAN });
  claim(L, "carol", { resource: "carol-mut-1", box: "boxa", cap_gib: 12, minutes: 60 });
  const no = claim(L, "frank", { resource: "frank-doc", box: "boxa", cap_gib: 8, minutes: 10 });
  const notHolder = claim(L, "frank", { resource: "carol-mut-1", release: true });
  const rel = claim(L, "carol", { resource: "carol-mut-1", release: true });
  const yes = claim(L, "frank", { resource: "frank-doc", box: "boxa", cap_gib: 8, minutes: 10 });
  check("over budget before the release", no.ok === false && no.code === "over_budget");
  check("a non-holder cannot release", notHolder.ok === false && notHolder.code === "not_holder", JSON.stringify(notHolder));
  check("the holder can release", rel.ok === true && rel.record.kind === "release");
  check("after the release the same claim fits", yes.ok === true, JSON.stringify(yes));
  const again = claim(L, "carol", { resource: "carol-mut-1", release: true });
  check("releasing what nobody holds is ok and changes nothing", again.ok === true && view(L, T0).boxes.boxa.in_use_gib === 8);
}

// ── an expired lease returns its cap ───────────────────────────────────────
{
  const L = newLedger(BUDGETS, { foreman: FOREMAN });
  claim(L, "carol", { resource: "carol-mut-1", box: "boxa", cap_gib: 12, minutes: 30 }, T0);
  const early = claim(L, "frank", { resource: "frank-doc", box: "boxa", cap_gib: 8, minutes: 10 }, T0 + min(29));
  const late = claim(L, "frank", { resource: "frank-doc", box: "boxa", cap_gib: 8, minutes: 10 }, T0 + min(31));
  check("a live lease still counts at minute 29", early.ok === false && early.code === "over_budget");
  check("an expired lease no longer counts at minute 31", late.ok === true, JSON.stringify(late));
  const gone = sweep(L, T0 + min(31));
  check("sweep reports what it dropped", gone.length === 1 && gone[0].resource === "carol-mut-1", JSON.stringify(gone));
}

// ── renewal re-checks the budget without counting itself twice ─────────────
{
  const L = newLedger(BUDGETS, { foreman: FOREMAN });
  claim(L, "carol", { resource: "carol-mut-1", box: "boxa", cap_gib: 10, minutes: 60 });
  claim(L, "dave", { resource: "dave-build", box: "boxa", cap_gib: 4, minutes: 60 });
  const same = claim(L, "carol", { resource: "carol-mut-1", box: "boxa", cap_gib: 10, minutes: 60 }, T0 + min(5));
  const grow = claim(L, "carol", { resource: "carol-mut-1", box: "boxa", cap_gib: 13, minutes: 60 }, T0 + min(6));
  check("renewing at the same cap is granted (own cap not double-counted)", same.ok === true, JSON.stringify(same));
  check("renewing to a cap that no longer fits is refused (4+13 > 16)", grow.ok === false && grow.code === "over_budget", JSON.stringify(grow));
  check("a refused renewal leaves the old lease intact", view(L, T0 + min(6)).boxes.boxa.in_use_gib === 14);
}

// ── the shape of a budgeted claim ──────────────────────────────────────────
{
  const L = newLedger(BUDGETS, { foreman: FOREMAN });
  const cases = [
    ["a box with no budget row", { resource: "x-1", box: "boxc", cap_gib: 1, minutes: 5 }, "unknown_box"],
    ["a cap on a budgeted box is required", { resource: "x-2", box: "boxa", minutes: 5 }, "cap_required"],
    ["minutes on a budgeted box are required", { resource: "x-3", box: "boxa", cap_gib: 1 }, "minutes_required"],
    ["a negative cap", { resource: "x-4", box: "boxa", cap_gib: -1, minutes: 5 }, "bad_cap"],
    ["a cap that is not a number", { resource: "x-5", box: "boxa", cap_gib: "8g", minutes: 5 }, "bad_cap"],
    ["zero minutes", { resource: "x-6", box: "boxa", cap_gib: 1, minutes: 0 }, "bad_minutes"],
    ["a lease longer than the box allows", { resource: "x-7", box: "boxa", cap_gib: 1, minutes: 1441 }, "bad_minutes"],
    ["a cap with no box", { resource: "x-8", cap_gib: 4, minutes: 5 }, "cap_without_box"],
    ["no resource", { box: "boxa", cap_gib: 1, minutes: 5 }, "resource_required"],
  ];
  for (const [label, req, code] of cases) {
    const d = claim(L, "probe", req);
    check(`refused: ${label}`, d.ok === false && d.code === code, JSON.stringify(d));
  }
  check("no refusal left a lease behind", Object.keys(view(L, T0).leases).length === 0);
  const malformed = claim(L, "probe", { resource: "x-8", cap_gib: 4, minutes: 5 });
  check("a malformed claim wakes nobody (route null)", malformed.code === "cap_without_box" && malformed.route === null, JSON.stringify(malformed));
  const unknown = claim(L, "probe", { resource: "x-1", box: "boxc", cap_gib: 1, minutes: 5 });
  check("an unknown box routes to the foreman", unknown.route === "foreman", JSON.stringify(unknown));
}

// ── a closed box refuses everything and routes ─────────────────────────────
{
  const L = newLedger(BUDGETS, { foreman: FOREMAN });
  const d = claim(L, "heidi", { resource: "heidi-judge", box: "boxb", cap_gib: 4, minutes: 30 });
  check("boxb refuses until its monitor reports", d.ok === false && d.code === "box_closed", JSON.stringify(d));
  check("and routes to the foreman with the reason", d.route === "foreman" && /monitor/.test(d.reason), JSON.stringify(d));
}

// ── a held resource is refused even when the budget has room ───────────────
{
  const L = newLedger(BUDGETS, { foreman: FOREMAN });
  claim(L, "carol", { resource: "boxa-gpu", box: "boxa", cap_gib: 0, minutes: 120 });
  const d = claim(L, "grace", { resource: "boxa-gpu", box: "boxa", cap_gib: 0, minutes: 30 });
  check("one holder per card", d.ok === false && d.code === "held" && d.held_by === "carol", JSON.stringify(d));
  check("a held card wakes nobody (route null)", d.route === null, JSON.stringify(d));
}

// ── an old-shape renewal keeps the lease's box, cap and minutes (threadchip #8833 A) ──
// Every running shim sends only {resource}. A holder renewing that way must not
// turn an 8 GiB, 60-minute lease into an unbudgeted 15-minute one: its cap would
// stop counting and the job would lose its lease at minute 20.
{
  const L = newLedger(BUDGETS, { foreman: FOREMAN });
  claim(L, "carol", { resource: "carol-mut-1", box: "boxa", cap_gib: 8, minutes: 60 }, T0);
  const ren = claim(L, "carol", { resource: "carol-mut-1" }, T0 + min(5));
  check("an old-shape renewal of a budgeted lease is granted", ren.ok === true, JSON.stringify(ren));
  check("and keeps its box, cap and minutes", ren.ok && ren.record.box === "boxa" && ren.record.cap_gib === 8 && ren.record.minutes === 60, JSON.stringify(ren));
  check("and runs from the renewal (T0+65)", ren.ok && ren.record.expires === new Date(T0 + min(65)).toISOString(), ren.ok && ren.record.expires);
  check("its cap still counts", view(L, T0 + min(5)).boxes.boxa.in_use_gib === 8, JSON.stringify(view(L, T0 + min(5)).boxes.boxa));
  const f = claim(L, "frank", { resource: "frank-doc", box: "boxa", cap_gib: 9, minutes: 10 }, T0 + min(6));
  check("so the budget still refuses past it (8+9 > 16)", f.ok === false && f.code === "over_budget", JSON.stringify(f));
  sweep(L, T0 + min(21));
  const g = claim(L, "grace", { resource: "carol-mut-1" }, T0 + min(21));
  check("and the lease is still held at minute 21", g.ok === false && g.code === "held" && g.held_by === "carol", JSON.stringify(g));
}

// ── the budget fails closed (threadchip #8833 B) ───────────────────────────
{
  const odd = {
    ...BUDGETS,
    boxf: { floor_gib: 8, route: "s" },
    boxg: { mem_gib: "16", route: "s" },
    boxh: { mem_gib: -4, route: "s" },
    boxi: "not a row",
  };
  const L = newLedger(odd, { foreman: FOREMAN });
  for (const box of ["boxf", "boxg", "boxh", "boxi"]) {
    const d = claim(L, "probe", { resource: `p-${box}`, box, cap_gib: 1000, minutes: 5 });
    check(`a row without a usable mem_gib refuses (${box})`, d.ok === false && d.code === "bad_budget" && d.route === FOREMAN, JSON.stringify(d));
  }
  for (const box of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    const d = claim(L, "probe", { resource: `p-${box}`, box, cap_gib: 1000, minutes: 5 });
    check(`a box name on Object.prototype is unknown (${box})`, d.ok === false && d.code === "unknown_box", JSON.stringify(d));
  }
  const parsed = newLedger(JSON.parse('{"__proto__": {"mem_gib": 999}, "boxa": {"mem_gib": 16}}'), { foreman: FOREMAN });
  const pp = claim(parsed, "probe", { resource: "p-pp", box: "__proto__", cap_gib: 500, minutes: 5 });
  check("a JSON row named __proto__ is not a budget", pp.ok === false, JSON.stringify(pp));
  const v = view(L, T0);
  check("view marks an unusable row instead of showing a free figure", v.boxes.boxf?.invalid && v.boxes.boxf.free_gib === undefined, JSON.stringify(v.boxes.boxf));
  check("no refusal above left a lease", Object.keys(v.leases).length === 0);
}

// ── the floor: a box's own reading beside its caps (docs/ledger.md section 4) ─
{
  const FB = { boxa: { mem_gib: 16, floor_gib: 8, route: "boxa-steward" }, boxc: { mem_gib: 16, route: "s" } };
  const L = newLedger(FB, { foreman: FOREMAN, staleS: 120 });
  noteReading(L, "boxa", { available_gib: 20, at: T0 });
  const a = claim(L, "alice", { resource: "alice-job", box: "boxa", cap_gib: 10, minutes: 60 }, T0 + 1000);
  check("floor: a claim that leaves the floor is granted (20 - 10 >= 8)", a.ok === true, JSON.stringify(a));
  const b = claim(L, "bob", { resource: "bob-job", box: "boxa", cap_gib: 4, minutes: 60 }, T0 + 2000);
  check("floor: caps granted since the reading count against it (20 - 10 - 4 < 8)", b.ok === false && b.code === "below_floor", JSON.stringify(b));
  check("floor: the refusal wakes nobody and shows its sum", b.route === null && b.available_gib === 20 && b.granted_since_gib === 10 && b.floor_gib === 8, JSON.stringify(b));
  check("floor: the caps alone would have granted it (10 + 4 <= 16)", view(L, T0 + 2000).boxes.boxa.in_use_gib === 10);
  noteReading(L, "boxa", { available_gib: 11, at: T0 + 30_000 }); // alice's job has allocated
  const c = claim(L, "bob", { resource: "bob-job", box: "boxa", cap_gib: 3, minutes: 60 }, T0 + 31_000);
  check("floor: a new reading counts what has allocated, not the old grants again (11 - 3 >= 8)", c.ok === true, JSON.stringify(c));
  noteReading(L, "boxa", { available_gib: 9, at: T0 + 60_000 });
  const ren = claim(L, "alice", { resource: "alice-job", box: "boxa", cap_gib: 10, minutes: 60 }, T0 + 61_000);
  check("floor: renewing a job the reading already holds does not count its cap again", ren.ok === true, JSON.stringify(ren));
  const grow = claim(L, "alice", { resource: "alice-job", box: "boxa", cap_gib: 12, minutes: 60 }, T0 + 62_000);
  check("floor: a renewal that grows counts only the growth (9 - 2 < 8)", grow.ok === false && grow.code === "below_floor", JSON.stringify(grow));
  const stale = claim(L, "carol", { resource: "carol-job", box: "boxa", cap_gib: 2, minutes: 5 }, T0 + 60_000 + 121_000);
  check("floor: a stale reading leaves the caps alone in force (13 + 2 <= 16)", stale.ok === true, JSON.stringify(stale));
  noteReading(L, "boxc", { available_gib: 1, at: T0 });
  const nofloor = claim(L, "dave", { resource: "dave-job", box: "boxc", cap_gib: 4, minutes: 5 }, T0 + 1000);
  check("floor: a row with no floor_gib ignores the reading", nofloor.ok === true, JSON.stringify(nofloor));
  const none = newLedger(FB, { foreman: FOREMAN });
  check("floor: a box with no reading at all is caps alone", claim(none, "erin", { resource: "e", box: "boxa", cap_gib: 15, minutes: 5 }, T0).ok === true);
  const bad = newLedger({ boxx: { mem_gib: 16, floor_gib: "8" } }, { foreman: FOREMAN });
  const bf = claim(bad, "probe", { resource: "p", box: "boxx", cap_gib: 1, minutes: 5 }, T0);
  check("floor: a floor_gib that is not a number makes the row unusable", bf.ok === false && bf.code === "bad_budget", JSON.stringify(bf));
}

// ── order, not the clock: a grant in the same millisecond as a reading is after it ─
// A reading and the next grant can share one Date.now(); compared by time, the
// grant looked included in the reading and its cap went uncounted (a Windows
// host's flake, basecamp #9147). First written as "its clock steps coarsely":
// measured there, the clock steps 1 ms (#9149), so the tie is within one
// millisecond and what makes it common on that host is not known. Ordering by a
// counter removes the question.
{
  const FB = { boxa: { mem_gib: 16, floor_gib: 8, route: "s" } };
  const L = newLedger(FB, { foreman: FOREMAN });
  noteReading(L, "boxa", { available_gib: 20, at: T0 });
  const a = claim(L, "alice", { resource: "alice-job", box: "boxa", cap_gib: 10, minutes: 60 }, T0);
  const b = claim(L, "bob", { resource: "bob-job", box: "boxa", cap_gib: 4, minutes: 60 }, T0);
  check("tie: a grant in the reading's own millisecond counts as after it", a.ok === true && b.ok === false && b.code === "below_floor" && b.granted_since_gib === 10, JSON.stringify(b));
  noteReading(L, "boxa", { available_gib: 11, at: T0 }); // a newer reading, same millisecond again
  const c = claim(L, "bob", { resource: "bob-job", box: "boxa", cap_gib: 3, minutes: 60 }, T0);
  check("tie: a newer reading in the same millisecond still supersedes the grants before it", c.ok === true, JSON.stringify(c));
}
{
  // a renewal keeps its first grant's place: the reading already holds the job
  const L = newLedger({ boxa: { mem_gib: 16, floor_gib: 8, route: "s" } }, { foreman: FOREMAN });
  claim(L, "alice", { resource: "alice-job", box: "boxa", cap_gib: 10, minutes: 60 }, T0);
  noteReading(L, "boxa", { available_gib: 20, at: T0 + 1000 });
  claim(L, "alice", { resource: "alice-job", box: "boxa", cap_gib: 10, minutes: 60 }, T0 + 2000); // renewal
  const b = claim(L, "bob", { resource: "bob-job", box: "boxa", cap_gib: 4, minutes: 60 }, T0 + 3000);
  check("a renewed job is not counted as granted since the reading (20 - 4 >= 8)", b.ok === true, JSON.stringify(b));
}

// ── a reserve: what the floor adds while a named service is absent (the box steward's rule) ─
// A reading taken while production is stopped (its card lent) sees production's
// memory as free; lending it would put production's restore on top of the loan.
{
  const RB = { boxa: { mem_gib: 40, floor_gib: 8, reserve: [{ absent: "prod", gib: 12 }], route: "s" } };
  const L = newLedger(RB, { foreman: FOREMAN });
  noteReading(L, "boxa", { available_gib: 30, at: T0, present: new Set(["prod", "db"]) });
  const a = claim(L, "alice", { resource: "a", box: "boxa", cap_gib: 20, minutes: 5 }, T0 + 1000);
  check("reserve: with prod present the floor is 8 (30 - 20 >= 8)", a.ok === true, JSON.stringify(a));
  claim(L, "alice", { resource: "a", release: true }, T0 + 2000);
  noteReading(L, "boxa", { available_gib: 30, at: T0 + 3000, present: new Set(["db"]) });
  const b = claim(L, "bob", { resource: "b", box: "boxa", cap_gib: 12, minutes: 5 }, T0 + 4000);
  check("reserve: with prod absent the floor is 8 + 12 (30 - 12 < 20)", b.ok === false && b.code === "below_floor" && b.floor_gib === 20 && b.reserve_gib === 12, JSON.stringify(b));
  check("reserve: the refusal names what is absent", /prod/.test(b.reason ?? ""), b.reason);
  const c = claim(L, "bob", { resource: "b", box: "boxa", cap_gib: 10, minutes: 5 }, T0 + 5000);
  check("reserve: a claim that leaves the raised floor is granted (30 - 10 >= 20)", c.ok === true, JSON.stringify(c));
  noteReading(L, "boxa", { available_gib: 30, at: T0 + 6000 }); // a sample with no container list
  // bob's 10 GiB was granted before this reading, so the reading already holds it
  const d = claim(L, "carol", { resource: "c", box: "boxa", cap_gib: 11, minutes: 5 }, T0 + 7000);
  check("reserve: a reading that cannot say what is healthy applies the reserve (30 - 11 < 20)", d.ok === false && d.code === "below_floor" && d.reserve_gib === 12, JSON.stringify(d));
  for (const [label, row] of [
    ["reserve not a list", { mem_gib: 40, floor_gib: 8, reserve: { absent: "prod", gib: 12 } }],
    ["reserve gib not a number", { mem_gib: 40, floor_gib: 8, reserve: [{ absent: "prod", gib: "12" }] }],
    ["reserve without a name", { mem_gib: 40, floor_gib: 8, reserve: [{ gib: 12 }] }],
    ["reserve without a floor", { mem_gib: 40, reserve: [{ absent: "prod", gib: 12 }] }],
  ]) {
    const bad = claim(newLedger({ boxq: row }, { foreman: FOREMAN }), "probe", { resource: "p", box: "boxq", cap_gib: 1, minutes: 5 }, T0);
    check(`reserve: an unusable row refuses (${label})`, bad.ok === false && bad.code === "bad_budget", JSON.stringify(bad));
  }
}

// ── replay: the ledger rebuilt from its own records is the same ledger ──────
{
  const L = newLedger(BUDGETS, { foreman: FOREMAN });
  const log = [];
  const step = (from, req, now) => {
    const d = decide(L, { from, ...req }, now);
    if (d.ok) { apply(L, d.record); log.push(JSON.parse(JSON.stringify(d.record))); }
  };
  step("carol", { resource: "carol-mut-1", box: "boxa", cap_gib: 8, minutes: 60 }, T0);
  step("dave", { resource: "dave-build", box: "boxa", cap_gib: 6, minutes: 30 }, T0 + min(1));
  step("alice", { resource: ":8080" }, T0 + min(2));
  step("dave", { resource: "dave-build", release: true }, T0 + min(3));
  step("carol", { resource: "carol-mut-1", box: "boxa", cap_gib: 8, minutes: 90 }, T0 + min(4));
  // the archive also holds every ordinary message; replay must skip them
  const archive = [{ id: 1, from: "x", to: null, text: "hello", ts: new Date(T0).toISOString() }, ...log];
  const R = replay(BUDGETS, archive, { foreman: FOREMAN });
  const at = T0 + min(5);
  check("replay rebuilds the same leases", JSON.stringify(view(R, at)) === JSON.stringify(view(L, at)),
    `\n   live   ${JSON.stringify(view(L, at))}\n   replay ${JSON.stringify(view(R, at))}`);
  check("replay keeps the renewed expiry", view(R, at).leases["carol-mut-1"]?.expires === new Date(T0 + min(94)).toISOString(),
    JSON.stringify(view(R, at).leases["carol-mut-1"]));
  const after = decide(R, { from: "frank", resource: "frank-doc", box: "boxa", cap_gib: 9, minutes: 10 }, at);
  check("a replayed ledger refuses what the live one would (8+9 > 16)", after.ok === false && after.code === "over_budget");
}

console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL GREEN — ledger: budgets, leases, refusals, replay.");
process.exit(fails ? 1 : 0);

#!/usr/bin/env node
/* test-ledger-hub.mjs — the ledger over the wire, on an isolated hub.
 *
 * test-ledger.mjs proves the arithmetic. This proves the hub around it:
 *   - a budgeted claim is granted or refused with a code, the old shape still works
 *   - grants, releases and refusals are archived, and delivered to nobody
 *   - they stay out of /history, so a seat catching up reads the conversation
 *   - the ledger survives a restart (it was ephemeral until 2026-10-16)
 *   - the archive still checks clean with the new records in it
 *   - the roster shows each lease's box, cap and expiry, and each box's sum
 *   - the budget file is read live, and an unreadable one keeps the last good table
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const PORT = await freePort();
const HUB = `http://127.0.0.1:${PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chillacks-ledger-"));
const TOKENS_FILE = path.join(DIR, "tokens.json");
const BUDGETS_FILE = path.join(DIR, "budgets.json");
const ARCHIVE = path.join(DIR, "room.jsonl");

const A = "alice", B = "bob", C = "carol";
const TOK = {
  [A]: "ledger-token-alice-aaaaaaaaaa",
  [B]: "ledger-token-bob-bbbbbbbbbbbb",
  [C]: "ledger-token-carol-cccccccccc",
};
fs.writeFileSync(TOKENS_FILE, JSON.stringify(TOK));
const BUDGETS = {
  boxa: { mem_gib: 16, max_minutes: 1440, route: "boxa-steward" },
  boxb: { closed: "boxb's headroom is read from the box, and it has no monitor yet", route: "foreman" },
};
fs.writeFileSync(BUDGETS_FILE, JSON.stringify(BUDGETS));

let fails = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) fails++;
};
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

function startHub() {
  const hub = spawn(process.execPath, ["hub.mjs"], {
    env: {
      ...process.env,
      CHILLACKS_PORT: String(PORT),
      CHILLACKS_ARCHIVE: DIR,
      CHILLACKS_TOKENS: TOKENS_FILE,
      CHILLACKS_BUDGETS: BUDGETS_FILE,
      CHILLACKS_FOREMAN: "foreman",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  hub.log = "";
  hub.stderr.on("data", (d) => (hub.log += d));
  return hub;
}
async function waitUp(hub) {
  for (let i = 0; i < 25 && !/chillacks hub/.test(hub.log); i++) await settle(150);
  if (!/chillacks hub/.test(hub.log)) {
    console.error(`hub failed to start:\n${hub.log}`);
    process.exit(2);
  }
}

let hub = startHub();
const cleanup = () => {
  try { hub.kill(); } catch {}
  fs.rmSync(DIR, { recursive: true, force: true });
};
process.on("exit", cleanup);
await waitUp(hub);

const hdr = (agent) => ({ "content-type": "application/json", "x-chillacks-token": TOK[agent] });
const post = async (agent, p, body) => {
  const r = await fetch(`${HUB}${p}`, { method: "POST", headers: hdr(agent), body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
};
const get = async (p) => (await fetch(`${HUB}${p}`, { headers: hdr(A) })).json();
const archived = () =>
  fs.readFileSync(ARCHIVE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// ── every agent listens, so "delivered to nobody" is observed, not assumed ──
const inbox = { [A]: [], [B]: [], [C]: [] };
const streams = [];
async function listen(agent) {
  const ctl = new AbortController();
  streams.push(ctl);
  const res = await fetch(`${HUB}/stream?agent=${agent}`, { headers: hdr(agent), signal: ctl.signal });
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of frame.split("\n"))
          if (line.startsWith("data: ")) inbox[agent].push(JSON.parse(line.slice(6)));
      }
    }
  })();
}
await listen(A); await listen(B); await listen(C);
await settle(400);

// ── budgeted claims over the wire ──────────────────────────────────────────
const g1 = await post(A, "/claim", { resource: "alice-job", box: "boxa", cap_gib: 8, minutes: 60 });
const g2 = await post(B, "/claim", { resource: "bob-job", box: "boxa", cap_gib: 6, minutes: 60 });
const r1 = await post(C, "/claim", { resource: "carol-job", box: "boxa", cap_gib: 4, minutes: 30 });
check("a budgeted claim is granted", g1.ok === true && g1.claimed === "alice-job" && g1.box === "boxa" && g1.cap_gib === 8, JSON.stringify(g1));
check("the grant answers the old shim's fields", g1.ttl_minutes === 60 && typeof g1.expires === "string", JSON.stringify(g1));
check("a claim past the budget is refused with its code", r1.status === 200 && r1.ok === false && r1.code === "over_budget" && r1.in_use_gib === 14, JSON.stringify(r1));
check("a full box wakes nobody (route null)", r1.route === null, JSON.stringify(r1));
const closed = await post(C, "/claim", { resource: "carol-job", box: "boxb", cap_gib: 1, minutes: 5 });
check("a closed box refuses and routes to the foreman", closed.ok === false && closed.code === "box_closed" && closed.route === "foreman", JSON.stringify(closed));
const held = await post(C, "/claim", { resource: "alice-job", box: "boxa", cap_gib: 0, minutes: 5 });
check("a held resource names its holder (old shim reads held_by, since)", held.ok === false && held.code === "held" && held.held_by === A && typeof held.since === "string", JSON.stringify(held));
const notHolder = await post(C, "/claim", { resource: "alice-job", release: true });
check("a non-holder release is still a 403", notHolder.status === 403, JSON.stringify(notHolder));

// ── the old shape, as every running shim sends it ──────────────────────────
const o1 = await post(A, "/claim", { resource: ":8080", release: false });
const o2 = await post(B, "/claim", { resource: ":8080", release: false });
check("old shape: granted, 15 minutes, no box", o1.ok === true && o1.claimed === ":8080" && o1.ttl_minutes === 15 && o1.box === null, JSON.stringify(o1));
check("old shape: conflict names the holder", o2.ok === false && o2.held_by === A, JSON.stringify(o2));

// an old shim renewing a budgeted lease sends exactly this body; the lease keeps its cap
const oldRenew = await post(A, "/claim", { resource: "alice-job", release: false });
check("an old shim's renewal keeps the lease's box, cap and minutes",
  oldRenew.ok === true && oldRenew.box === "boxa" && oldRenew.cap_gib === 8 && oldRenew.minutes === 60, JSON.stringify(oldRenew));

// ── release returns the cap ────────────────────────────────────────────────
const rel = await post(B, "/claim", { resource: "bob-job", release: true });
const g3 = await post(C, "/claim", { resource: "carol-job", box: "boxa", cap_gib: 4, minutes: 30 });
check("a release answers released (the old shim reads it)", rel.ok === true && rel.released === "bob-job", JSON.stringify(rel));
check("after a release the refused claim fits", g3.ok === true, JSON.stringify(g3));
await settle();

// ── archived, and delivered to nobody ──────────────────────────────────────
const recs = archived();
const kinds = recs.map((m) => m.kind).filter(Boolean);
check("grants are archived as kind claim", kinds.filter((k) => k === "claim").length === 5, JSON.stringify(kinds));
check("releases are archived as kind release", kinds.filter((k) => k === "release").length === 1, JSON.stringify(kinds));
check("refusals are archived as kind claim-refused", kinds.filter((k) => k === "claim-refused").length === 5, JSON.stringify(kinds));
const g1rec = recs.find((m) => m.kind === "claim" && m.resource === "alice-job");
check("a grant record carries box, cap, minutes, expiry, to:null and text",
  g1rec && g1rec.box === "boxa" && g1rec.cap_gib === 8 && g1rec.minutes === 60 && g1rec.to === null && typeof g1rec.text === "string" && typeof g1rec.expires === "string",
  JSON.stringify(g1rec));
check("no ledger record reached any stream",
  [A, B, C].every((n) => inbox[n].every((m) => !["claim", "release", "claim-refused"].includes(m.kind))),
  JSON.stringify(inbox));
const hist = await get("/history?limit=200");
check("no ledger record is in /history", hist.messages.every((m) => !["claim", "release", "claim-refused"].includes(m.kind)), JSON.stringify(hist.messages.map((m) => m.kind)));

// a message sent after the records still gets the next id, and still delivers
const dm = await post(A, "/send", { to: B, text: "after the ledger" });
await settle();
check("ordinary delivery is unchanged", inbox[B].some((m) => m.text === "after the ledger") && dm.id === recs.at(-1).id + 1, JSON.stringify(dm));

// ── the roster ─────────────────────────────────────────────────────────────
const ro = await get("/roster");
check("roster keeps claims[resource].by (the old shim renders it)", ro.claims?.["alice-job"]?.by === A, JSON.stringify(ro.claims));
check("roster claims carry box, cap and expiry", ro.claims?.["alice-job"]?.box === "boxa" && ro.claims["alice-job"].cap_gib === 8 && typeof ro.claims["alice-job"].expires === "string");
check("roster shows each box's sum", ro.budgets?.boxa?.in_use_gib === 12 && ro.budgets.boxa.budget_gib === 16 && ro.budgets?.boxb?.closed, JSON.stringify(ro.budgets));

// ── the archive is still sound ─────────────────────────────────────────────
let checkOut = "", checkCode = 0;
try { checkOut = execFileSync(process.execPath, ["check-archive.mjs", ARCHIVE], { encoding: "utf8" }); }
catch (e) { checkOut = (e.stdout || "") + (e.stderr || ""); checkCode = e.status; }
check("check-archive is clean with ledger records in it", checkCode === 0, checkOut.trim().split("\n").slice(-3).join(" | "));

// ── restart: the ledger comes back from the archive ────────────────────────
for (const s of streams) s.abort();
hub.kill();
await settle(400);
hub = startHub();
await waitUp(hub);
const after = await get("/roster");
check("leases survive a restart", after.claims?.["alice-job"]?.by === A && after.claims?.["carol-job"]?.by === C, JSON.stringify(after.claims));
check("a released lease stays released", !after.claims?.["bob-job"], JSON.stringify(after.claims));
check("the box's sum survives a restart", after.budgets?.boxa?.in_use_gib === 12, JSON.stringify(after.budgets));
const r2 = await post(B, "/claim", { resource: "bob-big", box: "boxa", cap_gib: 5, minutes: 10 });
check("after a restart the budget still refuses (12+5 > 16)", r2.ok === false && r2.code === "over_budget", JSON.stringify(r2));
const ren = await post(A, "/claim", { resource: "alice-job", box: "boxa", cap_gib: 8, minutes: 120 });
check("after a restart the holder can renew", ren.ok === true && ren.since === g1.since && ren.expires > oldRenew.expires, JSON.stringify(ren));
const hist2 = await get("/history?limit=200");
check("replayed ledger records stay out of /history", hist2.messages.every((m) => !["claim", "release", "claim-refused"].includes(m.kind)));

// ── the budget file is read live; a broken one keeps the last good table ───
fs.writeFileSync(BUDGETS_FILE, JSON.stringify({ ...BUDGETS, boxa: { ...BUDGETS.boxa, mem_gib: 32 } }));
await settle(600);
const g4 = await post(B, "/claim", { resource: "bob-big", box: "boxa", cap_gib: 5, minutes: 10 });
check("a raised budget takes effect without a restart", g4.ok === true, JSON.stringify(g4));
// a row with no usable figure refuses rather than granting anything
fs.writeFileSync(BUDGETS_FILE, JSON.stringify({ ...BUDGETS, boxa: { ...BUDGETS.boxa, mem_gib: 32 }, boxf: { route: "s" } }));
await settle(600);
// checked before any claim on boxf, and on the load line's own words: the
// refusal's log line also says "boxf" and "unusable", and an earlier version of
// this check passed on it with the load warning deleted
check("the hub logs the unusable row on load", /budget row boxf is unusable/.test(hub.log), hub.log.split("\n").filter((l) => /budget/.test(l)).slice(-2).join(" | "));
const bad = await post(B, "/claim", { resource: "bob-f", box: "boxf", cap_gib: 1000, minutes: 5 });
check("a budget row with no mem_gib refuses (fails closed)", bad.ok === false && bad.code === "bad_budget", JSON.stringify(bad));
fs.writeFileSync(BUDGETS_FILE, "{ not json");
await settle(600);
const ro2 = await get("/roster");
check("an unreadable budget file keeps the last good table", ro2.budgets?.boxa?.budget_gib === 32, JSON.stringify(ro2.budgets));

// ── R1 (threadchip #8842): a grant the archive did not take is refused ─────
// A grant that is applied but not recorded is forgotten at the next start, and
// the budget then grants past a running job. EACCES here stands in for ENOSPC
// or a scanner's lock.
fs.chmodSync(ARCHIVE, 0o444);
const unrec = await post(A, "/claim", { resource: "alice-unrec", box: "boxa", cap_gib: 1, minutes: 5 });
fs.chmodSync(ARCHIVE, 0o644);
check("a grant whose archive write fails is refused (503 not_recorded)", unrec.status === 503 && unrec.ok === false && unrec.code === "not_recorded", JSON.stringify(unrec));
check("and is not applied", !(await get("/roster")).claims?.["alice-unrec"], JSON.stringify((await get("/roster")).claims));
const lastId = archived().at(-1).id;
const nextMsg = await post(A, "/send", { to: B, text: "after a refused grant" });
check("the refused grant left no gap in the archive's ids", nextMsg.id === lastId + 1, `last ${lastId}, next ${nextMsg.id}`);

// ── R2 (threadchip #8842): a torn last line does not swallow the next record ─
// A crash mid-append leaves a line with no newline; the next append would join
// it, and the restart would skip both as one unparseable line.
for (const s of streams) s.abort();
hub.kill();
await settle(400);
fs.writeFileSync(BUDGETS_FILE, JSON.stringify({ ...BUDGETS, boxa: { ...BUDGETS.boxa, mem_gib: 32 } })); // the block above left it unreadable
fs.appendFileSync(ARCHIVE, '{"id":999999,"from":"bob","to":null,"chan');
hub = startHub();
await waitUp(hub);
const torn = await post(C, "/claim", { resource: "carol-after-tear", box: "boxa", cap_gib: 0, minutes: 30 });
check("a grant after a torn line is granted", torn.ok === true, JSON.stringify(torn));
hub.kill();
await settle(400);
hub = startHub();
await waitUp(hub);
check("and survives the next restart", (await get("/roster")).claims?.["carol-after-tear"]?.by === C, JSON.stringify((await get("/roster")).claims));
check("the torn bytes stay in the file, on their own line",
  fs.readFileSync(ARCHIVE, "utf8").split("\n").includes('{"id":999999,"from":"bob","to":null,"chan'));

console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL GREEN — the ledger over the wire: grants, refusals, archive, restart.");
process.exit(fails ? 1 : 0);

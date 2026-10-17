#!/usr/bin/env node
/* test-telemetry.mjs — box telemetry at the hub, and the floor it feeds.
 *
 * A box's monitor posts a sample as monitor-<box>; the hub keeps the latest per
 * box, shows it, and reads the box's floor_gib against it (docs/ledger.md
 * section 4). The box is the token's, never the body's. A sample is a reading:
 * not archived, not delivered. A box whose monitor goes quiet falls back to its
 * caps alone, with one status record each way and nobody woken.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });

const PORT = await freePort();
const HUB = `http://127.0.0.1:${PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chillacks-telemetry-"));
const TOKENS_FILE = path.join(DIR, "tokens.json");
const ARCHIVE = path.join(DIR, "room.jsonl");
const TOK = {
  alice: "tele-token-alice-aaaaaaaaaaaa",
  bob: "tele-token-bob-bbbbbbbbbbbbbb",
  "monitor-boxa": "tele-token-mona-mmmmmmmmmmmm",
  "monitor-boxc": "tele-token-monc-nnnnnnnnnnnn",
};
fs.writeFileSync(TOKENS_FILE, JSON.stringify(TOK));
fs.writeFileSync(path.join(DIR, "budgets.json"), JSON.stringify({
  boxa: { mem_gib: 16, floor_gib: 8, route: "boxa-steward" },
  boxc: { mem_gib: 16, route: "boxc-steward" },
}));

let fails = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) fails++;
};
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

function startHub() {
  const hub = spawn(process.execPath, ["hub.mjs"], {
    env: { ...process.env, CHILLACKS_PORT: String(PORT), CHILLACKS_ARCHIVE: DIR, CHILLACKS_TOKENS: TOKENS_FILE, CHILLACKS_TELEMETRY_STALE_S: "2" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  hub.log = "";
  hub.stderr.on("data", (d) => (hub.log += d));
  return hub;
}
async function waitUp(hub) {
  for (let i = 0; i < 25 && !/chillacks hub/.test(hub.log); i++) await settle(150);
  if (!/chillacks hub/.test(hub.log)) { console.error(`hub failed to start:\n${hub.log}`); process.exit(2); }
}
let hub = startHub();
process.on("exit", () => { try { hub.kill(); } catch {} fs.rmSync(DIR, { recursive: true, force: true }); });
await waitUp(hub);

const hdr = (who) => ({ "content-type": "application/json", "x-chillacks-token": TOK[who] });
const post = async (who, p, body) => {
  const r = await fetch(`${HUB}${p}`, { method: "POST", headers: hdr(who), body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
};
const get = async (p) => (await fetch(`${HUB}${p}`, { headers: hdr("alice") })).json();
const lines = () => fs.readFileSync(ARCHIVE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sampleOf = (box, available) => ({
  v: 1, box, ts: new Date().toISOString(), interval_s: 30, sample_ms: 50,
  mem: { total_gib: 60, available_gib: available, swap_used_gib: 0, shmem_gib: 8 },
  tmpfs: [], load: { load1: 0.5, load5: 0.4, cpus: 32 }, disk: [], gpu: [], top: [{ pid: 1, user: "root", rss_gib: 1, exe: "init" }], containers: [],
});

// alice and bob listen, so "delivered to nobody" is observed
const inbox = { alice: [], bob: [] };
for (const who of ["alice", "bob"]) {
  const res = await fetch(`${HUB}/stream?agent=${who}`, { headers: hdr(who) });
  (async () => {
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const f = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const l of f.split("\n")) if (l.startsWith("data: ")) inbox[who].push(JSON.parse(l.slice(6)));
      }
    }
  })();
}
await settle(400);

// ── who may post, and for which box ────────────────────────────────────────
const seat = await post("alice", "/telemetry", sampleOf("boxa", 50));
check("a seat cannot post telemetry (403)", seat.status === 403, JSON.stringify(seat));
const spoof = await post("monitor-boxa", "/telemetry", sampleOf("boxc", 1));
check("a monitor's sample is filed under its own box, not the body's", spoof.ok === true && spoof.box === "boxa", JSON.stringify(spoof));
let tel = await get("/telemetry");
check("so boxc has no reading", !tel.boxes?.boxc && tel.boxes?.boxa?.sample?.mem?.available_gib === 1, JSON.stringify(Object.keys(tel.boxes || {})));
check("the stored sample's box is the token's", tel.boxes?.boxa?.sample?.box === "boxa");
for (const [label, body] of [
  ["no mem", { ...sampleOf("boxa", 20), mem: undefined }],
  ["available not a number", { ...sampleOf("boxa", "20") }],
  ["a wrong version", { ...sampleOf("boxa", 20), v: 2 }],
  ["not an object", [1, 2]],
]) {
  const r = await post("monitor-boxa", "/telemetry", body);
  check(`a malformed sample is refused (400): ${label}`, r.status === 400, JSON.stringify(r));
}

// ── the floor over the wire ────────────────────────────────────────────────
await post("monitor-boxa", "/telemetry", sampleOf("boxa", 20));
const g1 = await post("alice", "/claim", { resource: "alice-job", box: "boxa", cap_gib: 10, minutes: 60 });
const r1 = await post("bob", "/claim", { resource: "bob-job", box: "boxa", cap_gib: 4, minutes: 60 });
check("a claim that leaves the floor is granted", g1.ok === true, JSON.stringify(g1));
check("one that would cross it is refused below_floor, waking nobody", r1.ok === false && r1.code === "below_floor" && r1.route === null && r1.granted_since_gib === 10, JSON.stringify(r1));
await post("monitor-boxa", "/telemetry", sampleOf("boxa", 11));
const g2 = await post("bob", "/claim", { resource: "bob-job", box: "boxa", cap_gib: 3, minutes: 60 });
check("a fresher reading lets it through (11 - 3 >= 8)", g2.ok === true, JSON.stringify(g2));
await post("monitor-boxc", "/telemetry", sampleOf("boxc", 1));
const g3 = await post("alice", "/claim", { resource: "alice-c", box: "boxc", cap_gib: 4, minutes: 5 });
check("a row with no floor_gib ignores the reading", g3.ok === true, JSON.stringify(g3));

// ── the roster, and nothing archived or delivered ──────────────────────────
// the last reading before the monitor goes quiet: low enough that the floor
// would refuse a 2 GiB claim (9 - 2 < 8), so the stale case below discriminates
await post("monitor-boxa", "/telemetry", sampleOf("boxa", 9));
const fl = await post("alice", "/claim", { resource: "alice-small", box: "boxa", cap_gib: 2, minutes: 5 });
check("while fresh, the floor refuses 2 GiB (9 - 2 < 8)", fl.ok === false && fl.code === "below_floor", JSON.stringify(fl));
const ro = await get("/roster");
check("the roster shows each box's reading", ro.telemetry?.boxa?.available_gib === 9 && ro.telemetry?.boxa?.load1 === 0.5 && ro.telemetry.boxa.stale === false && typeof ro.telemetry.boxa.age_s === "number", JSON.stringify(ro.telemetry));
check("no sample is in the archive", !lines().some((m) => m.mem || m.kind === "telemetry" || /available_gib/.test(JSON.stringify(m))));
check("no sample reached a stream", [...inbox.alice, ...inbox.bob].every((m) => !m.mem && m.kind !== "telemetry"), JSON.stringify(inbox));

// ── stale: caps alone, one status each way ─────────────────────────────────
await settle(2600); // past CHILLACKS_TELEMETRY_STALE_S=2, and past one stale sweep
const g4 = await post("alice", "/claim", { resource: "alice-small", box: "boxa", cap_gib: 2, minutes: 5 });
check("a stale reading leaves the caps alone in force (10 + 3 + 2 <= 16)", g4.ok === true, JSON.stringify(g4));
const staleRec = lines().filter((m) => m.kind === "status" && m.from === "chillacks" && /monitor-boxa.*stale/.test(m.text));
check("going stale writes one status record", staleRec.length === 1, JSON.stringify(staleRec.map((m) => m.text)));
check("the roster marks it stale", (await get("/roster")).telemetry?.boxa?.stale === true);
await settle(1500);
check("and only one, however long it stays stale", lines().filter((m) => m.kind === "status" && /monitor-boxa.*stale/.test(m.text)).length === 1);
await post("monitor-boxa", "/telemetry", sampleOf("boxa", 11));
await settle(200);
const back = lines().filter((m) => m.kind === "status" && m.from === "chillacks" && /monitor-boxa.*reporting again/.test(m.text));
check("reporting again writes one status record", back.length === 1, JSON.stringify(back.map((m) => m.text)));
check("no status record woke anyone", [...inbox.alice, ...inbox.bob].every((m) => m.kind !== "status"), JSON.stringify(inbox));

// ── a restart: no reading until the monitor posts ──────────────────────────
hub.kill();
await settle(400);
hub = startHub();
await waitUp(hub);
check("readings do not survive a restart", !(await get("/telemetry")).boxes?.boxa);
const g5 = await post("bob", "/claim", { resource: "bob-two", box: "boxa", cap_gib: 1, minutes: 5 });
check("so the box is caps alone until its monitor posts", g5.ok === true, JSON.stringify(g5));

console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL GREEN — telemetry: who posts, the floor, staleness, nothing archived.");
process.exit(fails ? 1 : 0);

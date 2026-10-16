#!/usr/bin/env node
/* test-quiet.mjs — the status kind, the quiet window, and the wake log.
 *
 * A status is a message for the record: archived, shown on the roster, and
 * delivered to nobody. A quiet window holds a recipient's DMs and acks for a
 * few seconds after the first, then delivers them as one wake. The wake log
 * (wakes.jsonl) records each delivery the hub actually makes, so a census can
 * count wakes instead of inferring them from the archive's fields.
 *
 * Every agent listens on a real stream, so "delivered to nobody" and "one
 * wake" are observed, not assumed.
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
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chillacks-quiet-"));
const TOKENS_FILE = path.join(DIR, "tokens.json");
const ARCHIVE = path.join(DIR, "room.jsonl");
const WAKES = path.join(DIR, "wakes.jsonl");

const A = "alice", B = "bob", C = "carol";
const TOK = {
  [A]: "quiet-token-alice-aaaaaaaaaa",
  [B]: "quiet-token-bob-bbbbbbbbbbbb",
  [C]: "quiet-token-carol-cccccccccc",
};
fs.writeFileSync(TOKENS_FILE, JSON.stringify(TOK));

let fails = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) fails++;
};
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

function startHub() {
  const hub = spawn(process.execPath, ["hub.mjs"], {
    env: { ...process.env, CHILLACKS_PORT: String(PORT), CHILLACKS_ARCHIVE: DIR, CHILLACKS_TOKENS: TOKENS_FILE },
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
process.on("exit", () => {
  try { hub.kill(); } catch {}
  fs.rmSync(DIR, { recursive: true, force: true });
});
await waitUp(hub);

const hdr = (agent) => ({ "content-type": "application/json", "x-chillacks-token": TOK[agent] });
const post = async (agent, p, body) => {
  const r = await fetch(`${HUB}${p}`, { method: "POST", headers: hdr(agent), body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
};
const get = async (p) => (await fetch(`${HUB}${p}`, { headers: hdr(A) })).json();
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

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

// ── status: archived, shown, delivered to nobody ───────────────────────────
const st = await post(A, "/send", { kind: "status", text: "deploy green at abc123" });
await settle();
check("a status is accepted and delivered to nobody", st.ok === true && st.delivered_to === 0 && st.status === true, JSON.stringify(st));
check("no stream received the status", [A, B, C].every((n) => !inbox[n].some((m) => m.text === "deploy green at abc123")));
const stRec = lines(ARCHIVE).find((m) => m.id === st.id);
check("the status is archived as kind status, to:null", stRec?.kind === "status" && stRec.to === null && stRec.from === A, JSON.stringify(stRec));
check("the status is in /history (a seat catching up can read it)", (await get("/history?limit=50")).messages.some((m) => m.id === st.id));
check("the roster shows the seat's latest status", (await get("/roster")).status?.[A]?.text === "deploy green at abc123", JSON.stringify((await get("/roster")).status));
const st2 = await post(A, "/send", { kind: "status", text: "merge done" });
check("a later status replaces it on the roster", (await get("/roster")).status?.[A]?.id === st2.id);
const stTo = await post(A, "/send", { kind: "status", to: B, text: "for bob?" });
const stCh = await post(A, "/send", { kind: "status", channel: "forge", text: "for forge?" });
check("a status with a recipient is refused (400)", stTo.status === 400, JSON.stringify(stTo));
check("a status with a channel is refused (400)", stCh.status === 400, JSON.stringify(stCh));
const odd = await post(A, "/send", { kind: "shout", text: "?" });
check("an unknown kind is refused (400)", odd.status === 400, JSON.stringify(odd));
check("a status leaves no wake in the log", !lines(WAKES).some((w) => w.ids.includes(st.id) || w.ids.includes(st2.id)), JSON.stringify(lines(WAKES)));

// ── the wake log records real deliveries ───────────────────────────────────
const d0 = await post(A, "/send", { to: C, text: "plain dm" });
await settle();
check("a DM to a present seat logs one wake", lines(WAKES).filter((w) => w.to === C && w.ids.includes(d0.id)).length === 1, JSON.stringify(lines(WAKES)));
const absent = await post(A, "/send", { to: "dave", text: "nobody home" });
check("a DM to an absent name logs no wake", !lines(WAKES).some((w) => w.ids.includes(absent.id)));

// ── the quiet window is held back (threadchip #8849 Q1, Q2; basecamp #8851) ─
// Held DMs were lost on a hub restart and when the recipient's stream was down
// at the close, while the sender had been told "delivered". Until both are
// fixed the door is shut: /quiet answers 501, and quiet.json is not loaded.
const q = await post(B, "/quiet", { seconds: 1.5 });
check("setting a quiet window answers 501 with the reason", q.status === 501 && q.ok === false && /held back/.test(q.error ?? ""), JSON.stringify(q));
check("the roster shows no window", JSON.stringify((await get("/roster")).quiet) === "{}", JSON.stringify((await get("/roster")).quiet));
const bBefore = inbox[B].length;
const h1 = await post(A, "/send", { to: B, text: "not held" });
await settle(300);
check("a DM arrives at once and is not reported held", h1.delivered_to === 1 && h1.held_s === undefined && inbox[B].slice(bBefore).some((m) => m.id === h1.id), JSON.stringify(h1));
check("clearing a window answers 501 too", (await post(B, "/quiet", { seconds: 0 })).status === 501);

// ── restart: statuses come back; a hand-written quiet.json does not open the door ─
fs.writeFileSync(path.join(DIR, "quiet.json"), JSON.stringify({ [C]: 60 }));
for (const s of streams) s.abort();
hub.kill();
await settle(400);
hub = startHub();
await waitUp(hub);
const ro = await get("/roster");
check("a quiet.json on disk is not loaded while windows are held back", JSON.stringify(ro.quiet) === "{}", JSON.stringify(ro.quiet));
check("the latest status survives a restart", ro.status?.[A]?.id === st2.id, JSON.stringify(ro.status));

// ── the archive is still sound ─────────────────────────────────────────────
let out = "", code = 0;
try { out = execFileSync(process.execPath, ["check-archive.mjs", ARCHIVE], { encoding: "utf8" }); }
catch (e) { out = (e.stdout || "") + (e.stderr || ""); code = e.status; }
check("check-archive is clean", code === 0, out.trim().split("\n").slice(-2).join(" | "));

console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL GREEN — status kind, quiet window, wake log.");
process.exit(fails ? 1 : 0);

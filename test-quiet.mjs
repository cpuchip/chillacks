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

function startHub(extra = {}) {
  const hub = spawn(process.execPath, ["hub.mjs"], {
    env: { ...process.env, CHILLACKS_PORT: String(PORT), CHILLACKS_ARCHIVE: DIR, CHILLACKS_TOKENS: TOKENS_FILE, ...extra },
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
/** agent -> its current stream's AbortController, so one seat can drop alone */
const ctls = {};
async function listen(agent) {
  const ctl = new AbortController();
  streams.push(ctl);
  ctls[agent] = ctl;
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
check("a status leaves no wake in the log", !lines(WAKES).some((w) => w.ids?.includes(st.id) || w.ids?.includes(st2.id)), JSON.stringify(lines(WAKES)));

// ── the wake log records real deliveries ───────────────────────────────────
const d0 = await post(A, "/send", { to: C, text: "plain dm" });
await settle();
check("a DM to a present seat logs one wake", lines(WAKES).filter((w) => w.to === C && w.ids?.includes(d0.id)).length === 1, JSON.stringify(lines(WAKES)));
const absent = await post(A, "/send", { to: "dave", text: "nobody home" });
check("a DM to an absent name logs no wake", !lines(WAKES).some((w) => w.ids?.includes(absent.id)));

// ── the quiet window ───────────────────────────────────────────────────────
const q = await post(B, "/quiet", { seconds: 1.5 });
check("a seat can set a quiet window", q.ok === true && q.seconds === 1.5, JSON.stringify(q));
check("the roster shows it", (await get("/roster")).quiet?.[B] === 1.5, JSON.stringify((await get("/roster")).quiet));
const bBefore = inbox[B].length;
const h1 = await post(A, "/send", { to: B, text: "reply one" });
const h2 = await post(C, "/send", { to: B, text: "reply two" });
const h3 = await post(A, "/send", { to: B, text: "reply three" });
check("a held DM still counts its recipient, and says it is held", h1.delivered_to === 1 && h1.held_s === 1.5, JSON.stringify(h1));
const ch = await post(A, "/send", { text: "all hands, not held" });
await settle(300);
check("nothing held reached bob during the window", !inbox[B].slice(bBefore).some((m) => /reply/.test(m.text ?? "")), JSON.stringify(inbox[B].slice(bBefore)));
check("#all is not held", inbox[B].some((m) => m.id === ch.id));
await settle(1600);
const after = inbox[B].slice(bBefore).filter((m) => m.id !== ch.id);
check("the window closes as ONE delivery", after.length === 1, JSON.stringify(after));
const dg = after[0] || {};
check("the digest is from chillacks, to bob, and names every held id",
  dg.from === "chillacks" && dg.to === B && dg.kind === "digest" && [h1, h2, h3].every((h) => dg.text.includes(`#${h.id}`)), JSON.stringify(dg));
check("the digest carries each sender and text", /alice: reply one/.test(dg.text) && /carol: reply two/.test(dg.text), dg.text);
const bWakes = lines(WAKES).filter((w) => w.to === B && w.ids?.some((i) => [h1.id, h2.id, h3.id].includes(i)));
check("the wake log has one line for the three", bWakes.length === 1 && bWakes[0].ids?.length === 3, JSON.stringify(bWakes));
check("the originals are archived, the digest is not",
  [h1, h2, h3].every((h) => lines(ARCHIVE).some((m) => m.id === h.id)) && !lines(ARCHIVE).some((m) => m.kind === "digest"));

// a window that held one message delivers it as itself
const one = await post(A, "/send", { to: B, text: "just one" });
await settle(1900);
const lone = inbox[B].filter((m) => m.text === "just one");
check("a window holding one message delivers the original", lone.length === 1 && lone[0].id === one.id && lone[0].from === A, JSON.stringify(lone));

// acks fold too; a channel message does not wait
await post(B, "/channel", { action: "join", channel: "forge" });
const bMark = inbox[B].length;
const ref = await post(B, "/send", { to: A, text: "ack me" });
const ak = await post(A, "/ack", { ref: ref.id, note: "seen" });
const cm = await post(A, "/send", { channel: "forge", text: "forge news" });
await settle(300);
check("a channel message reaches a quiet seat at once", inbox[B].slice(bMark).some((m) => m.id === cm.id));
check("an ack to a quiet seat is held", !inbox[B].slice(bMark).some((m) => m.id === ak.id));
await settle(1600);
check("and arrives when the window closes", inbox[B].slice(bMark).some((m) => m.id === ak.id || (m.kind === "digest" && m.text.includes(`#${ak.id}`))));

// the selftest echo is never held: it is how a seat proves it can hear
const echo = await post(B, "/send", { to: B, text: "selftest xyz", echo: true });
await settle(300);
check("a selftest echo bypasses the window", inbox[B].some((m) => m.id === echo.id), JSON.stringify(echo));

// clearing the window delivers what it holds now
const pend = await post(A, "/send", { to: B, text: "pending at clear" });
const clr = await post(B, "/quiet", { seconds: 0 });
await settle(300);
check("clearing the window flushes it at once", clr.ok === true && inbox[B].some((m) => m.id === pend.id), JSON.stringify(clr));
const now1 = await post(A, "/send", { to: B, text: "after clear" });
await settle(300);
check("after clearing, DMs arrive at once", inbox[B].some((m) => m.id === now1.id) && now1.held_s === undefined, JSON.stringify(now1));

// bounds
check("a negative window is refused", (await post(B, "/quiet", { seconds: -1 })).status === 400);
check("a window over 15 minutes is refused", (await post(B, "/quiet", { seconds: 901 })).status === 400);
check("a window that is not a number is refused", (await post(B, "/quiet", { seconds: "90" })).status === 400);

// ── held messages survive (threadchip #8849 Q1, Q2) ───────────────────────
const count = (agent, id) => inbox[agent].filter((m) => m.id === id || (m.kind === "digest" && m.ids?.includes(id))).length;
const restart = async (signal, extra = {}) => {
  for (const s of streams) s.abort();
  hub.kill(signal);
  await settle(400);
  hub = startHub(extra);
  await waitUp(hub);
};

// Q2: the recipient's stream is down when the window closes
await post(B, "/quiet", { seconds: 1 });
const away = await post(A, "/send", { to: B, text: "sent while you blinked" });
await settle(300);
ctls[B].abort();
await settle(1500); // the window closes while bob has no stream
check("Q2: nothing reached bob while he was away", count(B, away.id) === 0);
await listen(B);
await settle(500);
check("Q2: a batch whose recipient was away is delivered when he reconnects", count(B, away.id) === 1, JSON.stringify(inbox[B].slice(-2)));
check("Q2: and logged as one wake", lines(WAKES).filter((w) => w.to === B && w.ids?.includes(away.id)).length === 1, JSON.stringify(lines(WAKES).filter((w) => w.to === B).slice(-2)));

// Q1: a hard kill drops what is held; an #all delivered after the held DM must not mark it delivered
await post(B, "/quiet", { seconds: 3 });
const crash = await post(A, "/send", { to: B, text: "held when the hub died" });
const allAfter = await post(C, "/send", { text: "an #all after the held DM" });
await settle(300);
check("Q1: the #all reached bob at once", count(B, allAfter.id) === 1);
check("Q1: the held DM had not", count(B, crash.id) === 0);
await restart("SIGKILL");
await listen(A); await listen(B); await listen(C);
await settle(600);
check("Q1: after a hard kill and restart, the held DM reaches bob", count(B, crash.id) === 1, JSON.stringify(inbox[B].slice(-2)));
check("Q1: and the #all is not delivered twice", count(B, allAfter.id) === 1);

// a message delivered before a restart is not delivered again after it
await post(B, "/quiet", { seconds: 0.5 });
const done = await post(A, "/send", { to: B, text: "delivered before the restart" });
await settle(900);
check("delivered at the close", count(B, done.id) === 1);
await restart("SIGKILL");
await listen(A); await listen(B); await listen(C);
await settle(600);
check("not delivered again after a restart", count(B, done.id) === 1, `${count(B, done.id)}`);

// a clean stop delivers what is held before the streams close
await post(B, "/quiet", { seconds: 5 });
const term = await post(A, "/send", { to: B, text: "held at a clean stop" });
await settle(300);
hub.kill("SIGTERM");
await settle(500);
check("SIGTERM: what was held is delivered before the hub exits", count(B, term.id) === 1, JSON.stringify(inbox[B].slice(-2)));
hub = startHub();
await waitUp(hub);
for (const s of streams) s.abort();
await listen(A); await listen(B); await listen(C);
await settle(600);
check("SIGTERM: and not again after the restart", count(B, term.id) === 1, `${count(B, term.id)}`);

// a batch older than the age limit is dropped at reconnect, not delivered stale
await restart("SIGTERM", { CHILLACKS_HELD_MAX_S: "2" });
await listen(A); await listen(C);
await settle(300);
await post(B, "/quiet", { seconds: 0.5 });
const stale = await post(A, "/send", { to: B, text: "too old by the time you return" });
check("age limit: bob is away, so the DM is not held for him", stale.delivered_to === 0, JSON.stringify(stale));
await listen(B);
await post(B, "/quiet", { seconds: 0.5 });
const old = await post(A, "/send", { to: B, text: "held, then bob leaves for long" });
await settle(200);
ctls[B].abort();
await settle(3000);
await listen(B);
await settle(500);
check("age limit: a batch past the limit is not delivered at reconnect", count(B, old.id) === 0);
check("age limit: and the hub says it dropped it", /dropped 1 held message/.test(hub.log), hub.log.split("\n").filter((l) => /held/.test(l)).slice(-2).join(" | "));
await restart("SIGTERM");
await listen(A); await listen(B); await listen(C);
await settle(300);
await post(B, "/quiet", { seconds: 0 });

// ── restart: windows and statuses come back ────────────────────────────────
await post(C, "/quiet", { seconds: 60 });
for (const s of streams) s.abort();
hub.kill();
await settle(400);
hub = startHub();
await waitUp(hub);
const ro = await get("/roster");
check("a quiet window survives a restart", ro.quiet?.[C] === 60 && ro.quiet?.[B] === undefined, JSON.stringify(ro.quiet));
check("the latest status survives a restart", ro.status?.[A]?.id === st2.id, JSON.stringify(ro.status));

// ── the archive is still sound ─────────────────────────────────────────────
let out = "", code = 0;
try { out = execFileSync(process.execPath, ["check-archive.mjs", ARCHIVE], { encoding: "utf8" }); }
catch (e) { out = (e.stdout || "") + (e.stderr || ""); code = e.status; }
check("check-archive is clean", code === 0, out.trim().split("\n").slice(-2).join(" | "));

console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL GREEN — status kind, quiet window, wake log.");
process.exit(fails ? 1 : 0);

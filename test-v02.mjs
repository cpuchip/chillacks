#!/usr/bin/env node
/* test-v02.mjs — channels, mentions, ack, and claims: the retro's fixes work.
 *
 * Wire-level on purpose: the v0.2 semantics live in the HUB's delivery rules,
 * so this drives raw SSE + POST — the same protocol the shim speaks — with
 * three agents on an isolated hub. The shim's tool plumbing is a thin pass-
 * through tested by using it live.
 *
 * The behaviors under test, each of which earned its place in a retro:
 *   - a channel message wakes members, not the room     (broadcast was the cost)
 *   - @name reaches across a channel boundary           (mentions)
 *   - an ack reaches ONLY the acked message's sender    (costless ack)
 *   - a claim is a lease with a named holder            (six walkers, one file)
 *   - membership survives a hub restart                 (channels.json)
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
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const PORT = await freePort();
const HUB = `http://127.0.0.1:${PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chillacks-v02-"));
const TOKENS_FILE = path.join(DIR, "tokens.json");

const A = "alice", B = "bob", C = "carol";
const TOK = {
  [A]: "v02-token-alice-aaaaaaaaaaaa",
  [B]: "v02-token-bob-bbbbbbbbbbbbbb",
  [C]: "v02-token-carol-cccccccccccc",
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
    env: {
      ...process.env,
      CHILLACKS_PORT: String(PORT),
      CHILLACKS_ARCHIVE: DIR,
      CHILLACKS_TOKENS: TOKENS_FILE,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  hub.log = "";
  hub.stderr.on("data", (d) => (hub.log += d));
  return hub;
}

let hub = startHub();
const cleanup = () => {
  try { hub.kill(); } catch {}
  fs.rmSync(DIR, { recursive: true, force: true });
};
process.on("exit", cleanup);
for (let i = 0; i < 25 && !/chillacks hub/.test(hub.log); i++) await settle(150);
if (!/chillacks hub/.test(hub.log)) {
  console.error(`hub failed to start:\n${hub.log}`);
  process.exit(2);
}

const hdr = (agent) => ({
  "content-type": "application/json",
  "x-chillacks-token": TOK[agent],
});
const post = async (agent, p, body) => {
  const r = await fetch(`${HUB}${p}`, { method: "POST", headers: hdr(agent), body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
};

// ── inboxes: one SSE reader per agent ─────────────────────────────────────
const inbox = { [A]: [], [B]: [], [C]: [] };
async function listen(agent) {
  const res = await fetch(`${HUB}/stream?agent=${agent}`, { headers: hdr(agent) });
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

// ── channels scope delivery ───────────────────────────────────────────────
await post(A, "/channel", { action: "join", channel: "forge" });
await post(B, "/channel", { action: "join", channel: "#Forge" }); // normalized
const s1 = await post(A, "/send", { channel: "forge", text: "channel test one" });
await settle();
check("channel send reaches a member", inbox[B].some((m) => m.text === "channel test one"));
check("channel send skips a non-member", !inbox[C].some((m) => m.text === "channel test one"));
check("delivered_to counts members only", s1.delivered_to === 1, `got ${s1.delivered_to}`);

// ── mentions cross channels ───────────────────────────────────────────────
await post(A, "/send", { channel: "forge", text: "pulling in @carol for the seam" });
await settle();
check("a mention reaches a non-member", inbox[C].some((m) => /pulling in/.test(m.text)));

// ── DMs and #all unchanged ────────────────────────────────────────────────
await post(A, "/send", { to: B, text: "dm check" });
await post(A, "/send", { text: "all hands check" });
await settle();
check("DM reaches its target", inbox[B].some((m) => m.text === "dm check"));
check("DM skips others", !inbox[C].some((m) => m.text === "dm check"));
check("#all reaches everyone", inbox[B].some((m) => m.text === "all hands check") && inbox[C].some((m) => m.text === "all hands check"));

// ── ack reaches only the sender of the acked message ──────────────────────
const ridMsg = await post(B, "/send", { channel: "forge", text: "ack me" });
await settle();
const before = inbox[C].length;
const ack = await post(A, "/ack", { ref: ridMsg.id, note: "on it" });
await settle();
check("ack is delivered", ack.ok === true);
check("ack reaches only the acked sender", inbox[B].some((m) => m.kind === "ack" && m.ref === ridMsg.id));
check("ack wakes nobody else", inbox[C].length === before);

// ── claims: a lease with a named holder ───────────────────────────────────
const c1 = await post(A, "/claim", { resource: ":8080" });
const c2 = await post(B, "/claim", { resource: ":8080" });
const r1 = await post(B, "/claim", { resource: ":8080", release: true });
const r2 = await post(A, "/claim", { resource: ":8080", release: true });
const c3 = await post(B, "/claim", { resource: ":8080" });
check("first claim wins", c1.ok === true);
check("second claim names the holder", c2.ok === false && c2.held_by === A, JSON.stringify(c2));
check("a non-holder cannot release", r1.status === 403);
check("the holder can release", r2.ok === true);
check("a released resource can be re-claimed", c3.ok === true);

// ── roster carries the new state ──────────────────────────────────────────
const rosterRes = await fetch(`${HUB}/roster`, { headers: hdr(A) });
const roster = await rosterRes.json();
check("roster lists channels", Array.isArray(roster.channels?.forge) && roster.channels.forge.length === 2);
check("roster lists claims", roster.claims?.[":8080"]?.by === B, JSON.stringify(roster.claims));

// ── history filters by channel ────────────────────────────────────────────
const hist = await (await fetch(`${HUB}/history?channel=forge`, { headers: hdr(A) })).json();
check("history filters to the channel", hist.messages.length > 0 && hist.messages.every((m) => m.channel === "forge"));

// ── membership survives a restart ─────────────────────────────────────────
hub.kill();
await settle(400);
hub = startHub();
for (let i = 0; i < 25 && !/chillacks hub/.test(hub.log); i++) await settle(150);
const chans = await (await fetch(`${HUB}/channels`, { headers: hdr(A) })).json();
check("channels survive a hub restart", Array.isArray(chans.channels?.forge) && chans.channels.forge.includes(A) && chans.channels.forge.includes(B));
const claimsAfter = await (await fetch(`${HUB}/roster`, { headers: hdr(A) })).json();
check("claims are ephemeral by design", !claimsAfter.claims || Object.keys(claimsAfter.claims).length === 0);

// ── leave dissolves an empty group ────────────────────────────────────────
await post(A, "/channel", { action: "leave", channel: "forge" });
await post(B, "/channel", { action: "leave", channel: "forge" });
const chans2 = await (await fetch(`${HUB}/channels`, { headers: hdr(A) })).json();
check("last leave dissolves the group", !chans2.channels?.forge);

console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL GREEN — v0.2: channels, mentions, ack, claims.");
process.exit(fails ? 1 : 0);

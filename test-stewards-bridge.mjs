#!/usr/bin/env node
/* test-stewards-bridge.mjs: the wake bridge against a real hub and a fake
 * pg-ai-stewards HTTP MCP, both on free ports with their own archive and tokens.
 *
 * Why (2026-09-25): the bridge's one promise is "every wake is a row, and no
 * wake is lost". Its first review found a poll that recorded an item's new
 * state BEFORE the wake succeeded, so a single refused note lost the event for
 * good. The falsifiers run by hand were evidence; this is the oracle.
 *
 *   node test-stewards-bridge.mjs                      # the bridge beside this file
 *   BRIDGE_FILE=/path/to/other.mjs node test-...       # e.g. an older build, to watch it fail
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_FILE = process.env.BRIDGE_FILE || path.join(HERE, "stewards-bridge.mjs");

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await settle(100); }
  return cond();
}

let fails = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) fails++;
};

// --- the room: a real hub, isolated ------------------------------------------
const HUB_PORT = await freePort();
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chillacks-bridge-"));
const TOKENS_FILE = path.join(DIR, "tokens.json");
const SUB = "substrate", DRIVER = "driver", PEER = "peer";
const TOK = {
  [SUB]: "bridge-token-substrate-ssssss",
  [DRIVER]: "bridge-token-driver-dddddddd",
  [PEER]: "bridge-token-peer-pppppppppp",
};
fs.writeFileSync(TOKENS_FILE, JSON.stringify(TOK));
const hub = spawn(process.execPath, [path.join(HERE, "hub.mjs")], {
  env: { ...process.env, CHILLACKS_PORT: String(HUB_PORT), CHILLACKS_ARCHIVE: DIR, CHILLACKS_TOKENS: TOKENS_FILE },
  stdio: ["ignore", "ignore", "pipe"],
});
hub.stderr.on("data", () => {});
await until(() => false, 600); // let the hub bind

// --- the instance: a fake HTTP MCP with the tools the bridge may call ---------
const MCP_PORT = await freePort();
const MCP_TOKEN = "fake-mcp-bearer";
const items = new Map(); // id -> row
const notes = []; // {id, recipient, sender, body, work_item_id, acted}
const calls = []; // every tool the bridge called
const faults = { a2a_note: 0 };
const now = () => new Date().toISOString();
function putItem(row) { items.set(row.id, { escalation_state: "normal", escalation_attempts: 0, failure_count: 0, a2a_question: null, ...items.get(row.id), ...row, updated_at: now() }); }
function toolResult(name, args) {
  switch (name) {
    case "work_item_list":
      return { structuredContent: { items: [...items.values()].map(({ id, slug, status, pipeline_family, current_stage, updated_at }) => ({ id, slug, status, pipeline_family, current_stage, updated_at })) } };
    case "work_item_show":
      return { structuredContent: items.get(args.id_or_slug) || null };
    case "a2a_note": {
      if (faults.a2a_note > 0) { faults.a2a_note--; return { isError: true, content: [{ type: "text", text: "a2a_note: injected fault" }] }; }
      const n = { id: notes.length + 1, recipient: args.recipient, sender: args.sender, body: args.body, work_item_id: args.work_item_id || null, acted: false };
      notes.push(n);
      return { structuredContent: { sent: true, note_id: n.id, recipient: n.recipient } };
    }
    case "a2a_note_clear": {
      const n = notes.find((x) => x.id === args.note_id && x.recipient === args.recipient);
      if (n) n.acted = true;
      return { structuredContent: { cleared: n ? 1 : 0, recipient: args.recipient } };
    }
    case "substrate_tool":
      if (args.name === "a2a_inbox") {
        const mine = notes.filter((n) => n.recipient === args.args.agent_id && !n.acted).slice(0, 50);
        return { structuredContent: { agent_id: args.args.agent_id, notes: mine.map(({ id, sender, body, work_item_id }) => ({ id, sender, body, work_item_id })), todos: [] } };
      }
      return { isError: true, content: [{ type: "text", text: `substrate_tool: ${args.name} refused` }] };
    default:
      return null;
  }
}
const mcp = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  if (req.headers.authorization !== `Bearer ${MCP_TOKEN}`) { res.writeHead(401).end(); return; }
  const msg = JSON.parse(body || "{}");
  const reply = (obj) => { res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fake-session" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...obj })); };
  if (msg.method === "initialize") return reply({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
  if (!("id" in msg)) { res.writeHead(202).end(); return; }
  if (msg.method !== "tools/call") return reply({ error: { code: -32601, message: "method not found" } });
  const { name, arguments: args = {} } = msg.params;
  calls.push(name === "substrate_tool" ? `substrate_tool:${args.name}` : name);
  const r = toolResult(name, args);
  if (!r) return reply({ error: { code: -32602, message: `unknown tool "${name}"` } });
  return reply({ result: { content: [{ type: "text", text: JSON.stringify(r.structuredContent || {}) }], ...r } });
});
await new Promise((r) => mcp.listen(MCP_PORT, "127.0.0.1", r));

// --- the driver's ear ------------------------------------------------------------
const dms = []; // DMs from the substrate seat to the driver
const ctl = new AbortController();
(async () => {
  const res = await fetch(`${HUB}/stream?agent=${DRIVER}`, { headers: { "x-chillacks-token": TOK[DRIVER] }, signal: ctl.signal });
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
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try { const m = JSON.parse(line.slice(6)); if (m.from === SUB) dms.push(m); } catch {}
      }
    }
  }
})();
async function peerSays(text) {
  const r = await fetch(`${HUB}/send`, { method: "POST", headers: { "x-chillacks-token": TOK[PEER], "content-type": "application/json" }, body: JSON.stringify({ to: SUB, text }) });
  return (await r.json()).id;
}

// --- the bridge, as a child ---------------------------------------------------------
const STATE = path.join(DIR, "bridge-state.json");
const runs = []; // every bridge process, for the failure dump
function runBridge(extra = {}) {
  const p = spawn(process.execPath, [BRIDGE_FILE], {
    env: {
      ...process.env,
      CHILLACKS_AGENT: SUB, WAKE_TO: DRIVER, CHILLACKS_PORT: String(HUB_PORT),
      CHILLACKS_ARCHIVE: DIR, CHILLACKS_TOKENS: TOKENS_FILE,
      STEWARDS_MCP_URL: `http://127.0.0.1:${MCP_PORT}/mcp`, STEWARDS_MCP_TOKEN: MCP_TOKEN,
      WAKE_STATE: STATE, POLL_SECONDS: "1", STEWARDS_BRIDGE_FAULT: "", ...extra,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  p.log = "";
  p.stderr.on("data", (d) => (p.log += d));
  p.exited = new Promise((r) => p.on("exit", (code) => r(code)));
  runs.push(p);
  return p;
}
const dmsMatching = (re) => dms.filter((m) => re.test(m.text));
const wakeNotes = (key) => notes.filter((n) => n.recipient === `${SUB}-wakes` && n.body.includes(key));

try {
  // T0: a baseline wakes no news.
  putItem({ id: "item-done", slug: "old-done", status: "completed", pipeline_family: "p", current_stage: "s" });
  let bridge = runBridge();
  await until(() => /baseline/.test(bridge.log));
  await settle(1500);
  check("baseline: an item finished before the bridge wakes nobody", dms.length === 0, `${dms.length} DM(s)`);

  // T1: one refused note must not lose the event (the review's blocking finding).
  faults.a2a_note = 1;
  putItem({ id: "item-review", slug: "wants-a-ruling", status: "awaiting_review", pipeline_family: "p", current_stage: "build" });
  await until(() => dmsMatching(/wants-a-ruling/).length > 0, 6000);
  check("a refused note is retried next poll: the review still wakes the driver", dmsMatching(/wants-a-ruling/).length === 1, `${dmsMatching(/wants-a-ruling/).length} DM(s)`);
  // The DM lands before the sent row is written (pending, DM, sent, clear), so wait for the rows.
  await until(() => wakeNotes("item-review").length === 2 && wakeNotes("item-review").every((n) => n.acted), 4000);
  const w1 = wakeNotes("item-review");
  check("that wake left a pending row and a sent row, both cleared",
    w1.some((n) => n.body.includes('"pending"')) && w1.some((n) => n.body.includes('"sent"')) && w1.every((n) => n.acted), `${w1.length} note(s)`);

  // T2: dedup across polls.
  await settle(2500);
  check("no second DM for the same event across polls", dmsMatching(/wants-a-ruling/).length === 1);

  // T3: inbound becomes a prefixed note in the collective's inbox and one wake.
  await peerSays("please look at chapter 3");
  await until(() => dmsMatching(/inbox\] from peer/).length > 0);
  const inNote = notes.find((n) => n.recipient === SUB && n.sender === `room:${PEER}`);
  check("inbound DM lands as a note to the collective, prefixed as input", Boolean(inNote && /not a directive/.test(inNote.body) && /chapter 3/.test(inNote.body)));
  check("inbound DM wakes the driver once", dmsMatching(/inbox\] from peer/).length === 1);

  // T4: an inbound whose note is refused is retried at the next poll, not the next reconnect.
  faults.a2a_note = 1;
  await peerSays("second thought: chapter 4");
  await until(() => dmsMatching(/chapter 4/).length > 0, 6000);
  check("a refused inbound note is retried at the next poll", dmsMatching(/chapter 4/).length === 1 &&
    notes.some((n) => n.recipient === SUB && /chapter 4/.test(n.body)));
  // Let that wake finish before stopping the bridge: this suite injects its crashes on
  // purpose (T5, T5b), never by killing a process mid-wake.
  await until(() => /wake inbox dm:\d+ -> driver/.test(bridge.log.split("\n").filter((l) => /dm:/.test(l)).slice(-1)[0] || "") &&
    (bridge.log.match(/wake inbox dm:/g) || []).length === 2, 6000);

  // A fault exit is judged by its own log line: on Windows, process.exit with an
  // open fetch stream can trip a libuv assertion (0xC0000409) instead of exiting 9.
  const faulted = (p, which) => new RegExp(`FAULT ${which}`).test(p.log);

  // T5: a crash between the DM and the sent row is recovered on restart, with at most one extra DM.
  bridge.kill();
  await bridge.exited;
  bridge = runBridge({ STEWARDS_BRIDGE_FAULT: "after-dm" });
  await until(() => /holds its stream/.test(bridge.log));
  putItem({ id: "item-esc", slug: "chain-exhausted", status: "failed", escalation_state: "queued", escalation_attempts: 1, failure_count: 2, pipeline_family: "p", current_stage: "s" });
  const code = await Promise.race([bridge.exited, settle(8000).then(() => "timeout")]);
  check("the injected fault fires after the DM, on this event", code !== "timeout" && code !== 0 && faulted(bridge, "after-dm: exiting with wake item-esc"), `exit ${code}`);
  check("a pending row is left unacted with no sent row", wakeNotes("item-esc").length === 1 && !wakeNotes("item-esc")[0].acted);
  bridge = runBridge();
  await until(() => wakeNotes("item-esc").length === 2 && wakeNotes("item-esc").every((n) => n.acted), 8000);
  check("restart completes the half-done wake: pending + sent, both cleared", wakeNotes("item-esc").length === 2 && wakeNotes("item-esc").every((n) => n.acted));
  await settle(2000);
  const escDms = dmsMatching(/chain-exhausted/).length;
  check("that event reached the driver at most twice (one extra, never zero)", escDms >= 1 && escDms <= 2, `${escDms} DM(s)`);
  check("restart re-sent nothing already finished",
    dmsMatching(/wants-a-ruling/).length === 1 && dmsMatching(/inbox\] from peer/).length === 2,
    `review ${dmsMatching(/wants-a-ruling/).length}, inbox ${dmsMatching(/inbox\] from peer/).length} (expect 1, 2)`);

  // T5b: a crash after the sent row (recorded, not yet cached) re-sends NOTHING on restart.
  bridge.kill();
  await bridge.exited;
  bridge = runBridge({ STEWARDS_BRIDGE_FAULT: "after-sent" });
  await until(() => /holds its stream/.test(bridge.log));
  putItem({ id: "item-rev2", slug: "second-ruling", status: "awaiting_review", pipeline_family: "p", current_stage: "review" });
  const code2 = await Promise.race([bridge.exited, settle(8000).then(() => "timeout")]);
  check("the injected fault fires after the sent row", code2 !== "timeout" && faulted(bridge, "after-sent: exiting with wake item-rev2"), `exit ${code2}`);
  bridge = runBridge();
  await until(() => wakeNotes("item-rev2").length === 2 && wakeNotes("item-rev2").every((n) => n.acted), 8000);
  await settle(2500);
  check("restart after the sent row clears the rows and sends no second DM",
    wakeNotes("item-rev2").every((n) => n.acted) && dmsMatching(/second-ruling/).length === 1,
    `${dmsMatching(/second-ruling/).length} DM(s), ${wakeNotes("item-rev2").length} row(s)`);

  // T5c: a crash after the rows are cleared. Recovery can no longer see this wake,
  // so only the cache can stop a resend: it must be written BEFORE the clears.
  bridge.kill();
  await bridge.exited;
  bridge = runBridge({ STEWARDS_BRIDGE_FAULT: "after-clear" });
  await until(() => /holds its stream/.test(bridge.log));
  putItem({ id: "item-rev3", slug: "third-ruling", status: "awaiting_review", pipeline_family: "p", current_stage: "review" });
  const code3 = await Promise.race([bridge.exited, settle(8000).then(() => "timeout")]);
  check("the injected fault fires after the clears", code3 !== "timeout" && faulted(bridge, "after-clear: exiting with wake item-rev3"), `exit ${code3}`);
  bridge = runBridge();
  await until(() => /holds its stream/.test(bridge.log));
  await settle(3000);
  check("restart after the clears sends no second DM", dmsMatching(/third-ruling/).length === 1,
    `${dmsMatching(/third-ruling/).length} DM(s)`);

  // T6: the ruling wall. The bridge only ever called reads and notes.
  const allowed = new Set(["work_item_list", "work_item_show", "a2a_note", "a2a_note_clear", "substrate_tool:a2a_inbox"]);
  const strays = [...new Set(calls)].filter((c) => !allowed.has(c));
  check("the bridge called only reads and notes, never a ruling", strays.length === 0, strays.join(", ") || [...new Set(calls)].join(", "));

  bridge.kill();
  await bridge.exited;
} finally {
  ctl.abort();
  hub.kill();
  mcp.close();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
}

if (fails) {
  runs.forEach((p, i) => console.log(`\n--- bridge run ${i + 1} log ---\n${p.log}`));
  console.log("--- DMs to the driver ---");
  dms.forEach((m) => console.log(`#${m.id} ${m.text.slice(0, 90)}`));
}
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);

#!/usr/bin/env node
/**
 * stewards-bridge.mjs — wake a driver seat when a pg-ai-stewards instance needs
 * a ruling, and carry room input into that instance's record.
 *
 * A pg-ai-stewards instance runs its own work (pipelines, stages, tool calls)
 * but delivers nothing to the room. This bridge is its ear and its bell:
 *
 *   OUTBOUND  every POLL_SECONDS it reads the instance through its HTTP MCP
 *             (work_item_list, then work_item_show on each item that moved) and
 *             turns five kinds of change into ONE DM to the driver seat:
 *               review      status -> awaiting_review (a stage wants a ruling)
 *               question    awaiting_review with an a2a_question (a seat asked up)
 *               escalation  escalation_state -> queued after failed attempts
 *               failed      status failed and past the steward's retries
 *               done        status -> completed
 *   INBOUND   it holds the room stream as the instance's own seat; each DM to it
 *             becomes an a2a_note to the instance's collective inbox, prefixed
 *             so it reads as input and not as a directive, and wakes the driver
 *             (intake is the driver's job).
 *
 * EVERY WAKE IS A ROW. Before a wake's DM is sent, a `pending` a2a_note goes to
 * WAKE_RECIPIENT; after it, a `sent` note carrying the DM id; then both are
 * cleared (acted_at set, the rows stay as history). A crash between the two
 * leaves an unacted pending note, and the next start resends that one DM: at
 * most one extra DM, never a DM without a row, never a silent miss.
 *
 * THE BRIDGE CANNOT RULE. It holds two surfaces: the room, and the instance's
 * HTTP MCP bearer. That surface registers reads plus a2a_note/a2a_note_clear and
 * doc writes only; answering, resolving, advancing, dispatching are not
 * registered there, and the bridge has no database credential. Its only record
 * writes are notes.
 *
 * KNOWN LIMIT: work_item_list is read with limit 100 and no paging, so an
 * instance with more than 100 recent items stops seeing movement on the rest.
 * Fine for one mission at a time; page by updated_at before it is not.
 *
 * Zero dependencies, same as the hub. Nothing instance-specific is defaulted
 * here: every name comes from the environment. Tested by test-stewards-bridge.mjs.
 *
 *   CHILLACKS_AGENT     the instance's room seat (its token is read from the
 *                       store by this name, never printed)
 *   WAKE_TO             the driver seat to wake
 *   STEWARDS_MCP_URL    the instance's HTTP MCP endpoint (…/mcp)
 *   STEWARDS_MCP_TOKEN  its bearer, or STEWARDS_MCP_TOKEN_FILE (a dotenv file)
 *                       + STEWARDS_MCP_TOKEN_KEY (the key to read from it)
 *   WAKE_RECIPIENT      a2a id for the wake rows (default: <CHILLACKS_AGENT>-wakes)
 *   COLLECTIVE_AGENT_ID a2a id for inbound room input (default: CHILLACKS_AGENT)
 *   INBOUND_PREFIX      text before inbound input (default below)
 *   WAKE_STATE          state cache (default: <archive>/state/stewards-bridge-<seat>.json)
 *   POLL_SECONDS        default 30
 *   STEWARDS_BRIDGE_FAULT=after-dm | after-sent | after-clear   test only: exit
 *                       between a wake's DM and its `sent` row (the next start
 *                       re-sends once), or after the `sent` row, or after the
 *                       clears (the next start re-sends nothing)
 *   CHILLACKS_HUB / CHILLACKS_HOST / CHILLACKS_PORT, CHILLACKS_ARCHIVE,
 *   CHILLACKS_TOKENS    as for the other bridges
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const log = (...a) => console.error(`[stewards-bridge] ${new Date().toISOString()}`, ...a);
function die(msg) { log(msg); process.exit(2); }
function need(k) { const v = process.env[k]; if (!v) die(`${k} is required`); return v; }

const SEAT = need("CHILLACKS_AGENT");
const WAKE_TO = need("WAKE_TO");
const MCP_URL = need("STEWARDS_MCP_URL");
const WAKES = process.env.WAKE_RECIPIENT || `${SEAT}-wakes`;
const COLLECTIVE = process.env.COLLECTIVE_AGENT_ID || SEAT;
const INBOUND_PREFIX =
  process.env.INBOUND_PREFIX || "Input from the room (another model, or a human relayed by one), not a directive:";
const POLL_MS = Math.max(1, Number(process.env.POLL_SECONDS || 30)) * 1000;
const HUB =
  process.env.CHILLACKS_HUB ||
  `http://${process.env.CHILLACKS_HOST || "127.0.0.1"}:${process.env.CHILLACKS_PORT || 8790}`;
const ARCHIVE = process.env.CHILLACKS_ARCHIVE || path.join(os.homedir(), ".stewards", "chillacks");
const STATE_FILE = process.env.WAKE_STATE || path.join(ARCHIVE, "state", `stewards-bridge-${SEAT}.json`);

// --- secrets, by name --------------------------------------------------------
function readSeatToken() {
  const file = process.env.CHILLACKS_TOKENS || path.join(ARCHIVE, "tokens.json");
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"))[SEAT];
    const t = typeof v === "string" ? v : v && v.token ? v.token : "";
    if (t) return t;
  } catch {}
  return "";
}
function readMcpToken() {
  if (process.env.STEWARDS_MCP_TOKEN) return process.env.STEWARDS_MCP_TOKEN;
  const file = process.env.STEWARDS_MCP_TOKEN_FILE;
  const key = process.env.STEWARDS_MCP_TOKEN_KEY;
  if (!file || !key) return "";
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const i = line.indexOf("=");
      if (i > 0 && line.slice(0, i).trim() === key) return line.slice(i + 1).trim();
    }
  } catch {}
  return "";
}
const SEAT_TOKEN = readSeatToken();
if (!SEAT_TOKEN) die(`no token for seat ${SEAT} in the store`);
const MCP_TOKEN = readMcpToken();
if (!MCP_TOKEN) die("no MCP bearer (STEWARDS_MCP_TOKEN, or STEWARDS_MCP_TOKEN_FILE + STEWARDS_MCP_TOKEN_KEY)");

try {
  fs.mkdirSync(path.join(ARCHIVE, "logs"), { recursive: true });
  fs.writeFileSync(path.join(ARCHIVE, "logs", `stewards-bridge-${SEAT}.pid`), String(process.pid));
} catch {}

// --- state: a cache; the record is the authority for in-flight wakes ---------
// { items: {id: updated_at}, seen: {key: 1}, lastDm: number, baselined: bool }
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return null; }
}
let state = loadState();
const fresh = !state;
if (!state) state = { items: {}, seen: {}, lastDm: 0, baselined: false };
function saveState() {
  const keys = Object.keys(state.seen);
  if (keys.length > 5000) for (const k of keys.slice(0, keys.length - 5000)) delete state.seen[k];
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

// --- the instance's HTTP MCP (streamable HTTP, JSON or SSE replies) ----------
let mcpSession = "";
let rpcId = 0;
async function rpc(method, params, notify = false) {
  const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++rpcId, method, params };
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${MCP_TOKEN}`,
      ...(mcpSession ? { "mcp-session-id": mcpSession } : {}),
    },
    body: JSON.stringify(body),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) mcpSession = sid;
  if (notify) return null;
  if (!res.ok) throw new Error(`mcp ${method} http ${res.status}`);
  const text = await res.text();
  const payload = (res.headers.get("content-type") || "").includes("event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).pop()
    : text;
  const msg = JSON.parse(payload);
  if (msg.error) throw new Error(`mcp ${method}: ${msg.error.message}`);
  return msg.result;
}
async function mcpInit() {
  mcpSession = "";
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "stewards-bridge", version: "0.1.0" },
  });
  await rpc("notifications/initialized", {}, true);
}
async function tool(name, args) {
  for (let attempt = 0; ; attempt++) {
    try {
      if (!mcpSession) await mcpInit();
      const r = await rpc("tools/call", { name, arguments: args });
      if (r.isError) throw new Error(`${name}: ${(r.content?.[0]?.text || "").slice(0, 200)}`);
      if (r.structuredContent) return r.structuredContent;
      const t = r.content?.[0]?.text || "";
      try { return JSON.parse(t); } catch { return t; }
    } catch (e) {
      if (attempt >= 1 || !/http 4\d\d/.test(e.message)) throw e;
      mcpSession = ""; // a stale session: initialize once more, then give up
    }
  }
}

// --- the room ----------------------------------------------------------------
const hubHeaders = { "x-chillacks-token": SEAT_TOKEN };
async function dm(to, text) {
  const res = await fetch(`${HUB}/send`, {
    method: "POST",
    headers: { ...hubHeaders, "content-type": "application/json" },
    body: JSON.stringify({ to, text }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(`send ${res.status} ${j.error || ""}`);
  return j.id;
}

// --- the wake protocol: row, DM, row, clear ----------------------------------
const inflight = new Map(); // key -> {pendingId, text, workItemId}
async function note(body, workItemId) {
  const r = await tool("a2a_note", {
    recipient: WAKES,
    sender: "stewards-bridge",
    body: JSON.stringify(body),
    ...(workItemId ? { work_item_id: workItemId } : {}),
  });
  return r.note_id;
}
async function wake(key, event, text, workItemId) {
  if (state.seen[key]) return;
  let f = inflight.get(key);
  if (!f) {
    const pendingId = await note({ phase: "pending", event, key, text, at: new Date().toISOString() }, workItemId);
    f = { pendingId, text, workItemId };
    inflight.set(key, f);
  }
  const dmId = await dm(WAKE_TO, f.text);
  // Fault injection for the recovery falsifier: die in the one window that
  // matters (DM sent, `sent` row not yet written). Never set in production.
  if (process.env.STEWARDS_BRIDGE_FAULT === "after-dm") {
    log(`FAULT after-dm: exiting with wake ${key} half-done (dm #${dmId})`);
    process.exit(9);
  }
  const sentId = await note({ phase: "sent", key, dm_id: dmId, pending_note: f.pendingId, at: new Date().toISOString() }, f.workItemId);
  if (process.env.STEWARDS_BRIDGE_FAULT === "after-sent") {
    log(`FAULT after-sent: exiting with wake ${key} recorded but not cached (dm #${dmId})`);
    process.exit(9);
  }
  // Cache BEFORE clearing: once both rows are cleared, recovery can no longer
  // see this wake, so the cache must already know it (a restart in that window
  // otherwise re-woke it; found by the suite, 2026-09-25). A crash from here on
  // leaves rows recovery completes quietly, or a cache that skips the event.
  inflight.delete(key);
  state.seen[key] = 1;
  saveState();
  await tool("a2a_note_clear", { recipient: WAKES, note_id: f.pendingId });
  await tool("a2a_note_clear", { recipient: WAKES, note_id: sentId });
  if (process.env.STEWARDS_BRIDGE_FAULT === "after-clear") {
    log(`FAULT after-clear: exiting with wake ${key} cleared (dm #${dmId})`);
    process.exit(9);
  }
  log(`wake ${event} ${key} -> ${WAKE_TO} (dm #${dmId})`);
}

// On start: unacted notes under WAKES are wakes that did not finish.
async function recover() {
  const box = await tool("substrate_tool", { name: "a2a_inbox", args: { agent_id: WAKES } });
  const notes = (box && box.notes) || [];
  const byKey = new Map();
  for (const n of notes) {
    let b;
    try { b = JSON.parse(n.body); } catch { continue; }
    const e = byKey.get(b.key) || {};
    if (b.phase === "pending") e.pending = { id: n.id, text: b.text, workItemId: n.work_item_id };
    if (b.phase === "sent") e.sent = n.id;
    byKey.set(b.key, e);
  }
  for (const [key, e] of byKey) {
    if (e.pending && !e.sent) {
      log(`recover: resending unfinished wake ${key}`);
      inflight.set(key, { pendingId: e.pending.id, text: e.pending.text, workItemId: e.pending.workItemId });
      delete state.seen[key];
      await wake(key, "recovered", e.pending.text, e.pending.workItemId);
    } else if (e.sent) {
      if (e.pending) await tool("a2a_note_clear", { recipient: WAKES, note_id: e.pending.id });
      await tool("a2a_note_clear", { recipient: WAKES, note_id: e.sent });
      state.seen[key] = 1;
    }
  }
  saveState();
  if (notes.length) log(`recover: ${byKey.size} unfinished wake(s) handled`);
}

// --- outbound: record -> wake ------------------------------------------------
// steward_tick retries a failed item while failure_count < 3 (its own WHERE clause)
// and queues it for escalation when the model ladder runs out, so a failure below
// that line is the steward's to handle, not the driver's: waking on it would be a
// wake the driver can only answer with "you could have decided this".
const STEWARD_MAX_FAILURES = Number(process.env.STEWARD_MAX_FAILURES || 3);
function classify(w) {
  if (w.status === "awaiting_review" && w.a2a_question) return "question";
  if (w.escalation_state === "queued" && Number(w.escalation_attempts || 0) > 0) return "escalation";
  if (w.status === "awaiting_review" && w.escalation_state !== "queued") return "review";
  if (w.status === "failed" && Number(w.failure_count || 0) >= STEWARD_MAX_FAILURES) return "failed";
  if (w.status === "completed") return "done";
  return null;
}
function describe(event, w) {
  const id8 = String(w.id).slice(0, 8);
  const head = `[${SEAT} wake] ${event}: ${w.slug || id8} (${id8}) ${w.pipeline_family}/${w.current_stage} is ${w.status}`;
  const why = String(w.last_failure_reason || "").slice(0, 200);
  switch (event) {
    case "question": return `${head}. It asks: "${String(w.a2a_question).slice(0, 300)}". Answer it.`;
    case "escalation": return `${head}, escalation queued (${why || "model chain exhausted"}). Rule on it.`;
    case "review": return `${head}. Read stage_results and rule.`;
    case "failed": return `${head}${why ? ` (${why})` : ""}. Retry or strike.`;
    default: return `${head}. Read the result.`;
  }
}
// Movement is a SIGNATURE of the fields that decide an event, not updated_at:
// steward_tick's escalation UPDATE sets escalation_state/attempts without touching
// updated_at (measured 2026-09-25: updated_at 15:31:24, queued 15:31:45), so a
// watcher keyed on updated_at misses real escalations. Every item that is not
// finished is re-read each poll; finished items are re-read only if they moved.
const FINISHED = new Set(["completed", "cancelled"]);
function signature(w) {
  return [w.status, w.escalation_state, w.escalation_attempts, w.failure_count,
    w.a2a_question ? String(w.a2a_question).length : 0, w.updated_at].join("|");
}
async function poll() {
  const list = await tool("work_item_list", { limit: 100 });
  const items = (list && list.items) || [];
  const first = !state.baselined;
  for (const it of items) {
    const prev = state.items[it.id];
    if (FINISHED.has(it.status) && prev && prev.endsWith(`|${it.updated_at}`)) continue;
    try {
      const w = await tool("work_item_show", { id_or_slug: it.id });
      if (!w || typeof w !== "object") continue;
      const sig = signature(w);
      if (sig === prev) continue;
      const event = classify(w);
      // A first poll (no state) wakes only OPEN ASKS, which wait on the driver no
      // matter when they arrived; news (done, failed) from before is recorded quietly.
      if (event && (!first || OPEN_ASKS.has(event))) {
        await wake(`${w.id}:${event}:${sig}`, event, describe(event, w), w.id);
      }
      // Only now: a wake that threw leaves the old signature, so the next poll
      // re-reads the item and retries (the first review, 2026-09-25).
      state.items[it.id] = sig;
      saveState();
    } catch (e) {
      log(`item ${String(it.id).slice(0, 8)}: ${e.message}; retried next poll`);
    }
  }
  if (first) {
    state.baselined = true;
    saveState();
    log(`baseline: ${items.length} existing item(s) recorded; open asks woken, news not`);
  }
}
const OPEN_ASKS = new Set(["review", "question", "escalation"]);

// --- inbound: room -> record ---------------------------------------------------
// A DM whose note or wake throws waits here and is retried at the next poll, not
// the next reconnect; lastDm (the catch-up watermark) never passes a DM still
// waiting, so a restart re-reads it from the hub's history.
const retryInbound = new Map(); // id -> msg
function advanceLastDm(id) {
  const waiting = [...retryInbound.keys()];
  const ceiling = waiting.length ? Math.min(...waiting) - 1 : Infinity;
  state.lastDm = Math.min(Math.max(state.lastDm || 0, id), ceiling);
  saveState();
}
async function inboundSafe(msg) {
  try {
    await inbound(msg);
    retryInbound.delete(msg.id);
    advanceLastDm(msg.id);
  } catch (e) {
    retryInbound.set(msg.id, msg);
    advanceLastDm(msg.id);
    log(`inbound #${msg.id} failed: ${e.message}; retried next poll`);
  }
}
async function drainInbound() {
  for (const msg of [...retryInbound.values()].sort((a, b) => a.id - b.id)) await inboundSafe(msg);
}
async function inbound(msg) {
  if (!msg || msg.from === SEAT || msg.kind === "ack" || msg.to !== SEAT) return;
  if (state.lastDm && msg.id <= state.lastDm && !retryInbound.has(msg.id)) return;
  const key = `dm:${msg.id}`;
  if (!state.seen[`${key}:noted`]) {
    await tool("a2a_note", {
      recipient: COLLECTIVE,
      sender: `room:${msg.from}`,
      body: `${INBOUND_PREFIX} from ${msg.from} (room msg #${msg.id}): ${msg.text}`,
    });
    state.seen[`${key}:noted`] = 1;
    saveState();
  }
  await wake(key, "inbox", `[${SEAT} inbox] from ${msg.from} (#${msg.id}): ${String(msg.text).slice(0, 200)}`, null);
}
async function catchUp() {
  const res = await fetch(`${HUB}/history?limit=200`, { headers: hubHeaders });
  if (!res.ok) return;
  const j = await res.json().catch(() => ({}));
  const mine = (j.messages || []).filter((m) => m.to === SEAT && m.from !== SEAT);
  if (!state.lastDm) {
    // First start: history before now is not input to this bridge.
    state.lastDm = mine.reduce((a, m) => Math.max(a, m.id), 0);
    saveState();
    return;
  }
  for (const m of mine.sort((a, b) => a.id - b.id)) if (m.id > state.lastDm) await inboundSafe(m);
}
async function listen() {
  const res = await fetch(`${HUB}/stream?agent=${encodeURIComponent(SEAT)}`, { headers: hubHeaders });
  if (!res.ok) throw new Error(`stream ${res.status}`);
  log(`${SEAT} holds its stream; waking ${WAKE_TO}`);
  await catchUp();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        let msg;
        try { msg = JSON.parse(line.slice(6)); } catch { continue; }
        if (msg && msg.to === SEAT && msg.from !== SEAT && msg.kind !== "ack") await inboundSafe(msg);
      }
    }
  }
  throw new Error("stream ended");
}

// --- run -----------------------------------------------------------------------
async function roomLoop() {
  let delay = 1000;
  for (;;) {
    try { await listen(); delay = 1000; } catch (e) {
      log(`room: ${e.message}; retry in ${delay} ms`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15_000);
    }
  }
}
async function recordLoop() {
  for (;;) {
    try { await drainInbound(); } catch (e) { log(`inbound retry: ${e.message}`); }
    try { await poll(); } catch (e) { log(`poll: ${e.message}`); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
async function main() {
  log(`starting: seat ${SEAT}, driver ${WAKE_TO}, wakes -> ${WAKES}, collective ${COLLECTIVE}, poll ${POLL_MS / 1000}s${fresh ? " (no state: will baseline)" : ""}`);
  for (;;) {
    try { await recover(); break; } catch (e) {
      log(`recover: ${e.message}; retry in 5 s`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  roomLoop();
  recordLoop();
}
main();

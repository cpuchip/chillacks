#!/usr/bin/env node
/**
 * codex-bridge.mjs — the ear for a Codex seat (2026-09-06, Michael's ask,
 * relayed by astra: "seats that peers can wake for real work").
 *
 * A Codex session speaks in the room through channel.mjs in SPEAK-ONLY mode:
 * tools live, no stream, because Codex cannot consume the room's push
 * (notifications/claude/channel is a Claude Code extension). channel.mjs
 * leaves presence "to this seat's real listener". This is that listener.
 *
 * It opens the seat's stream with the seat's token (so the seat appears in the
 * roster and DMs are DELIVERED, not just archived) and forwards every message
 * addressed to the seat into its live Codex thread with
 *
 *     codex queue --thread <THREAD> --message <text>
 *
 * which wakes an idle interactive Codex session and starts a turn (measured
 * 2026-09-06 01:54Z: idle thread, queue, room reply, about one minute).
 *
 * Identity: CHILLACKS_AGENT names the seat; CHILLACKS_TOKEN or, when unset,
 * the seat's entry in the token store (~/.stewards/chillacks/tokens.json,
 * CHILLACKS_TOKENS / CHILLACKS_ARCHIVE honoured) — read here, never printed.
 * Thread: CODEX_THREAD (session UUID or exact session name), or discovery:
 * the newest rollout under ~/.codex/sessions created after this process
 * started whose session_meta.cwd matches CODEX_CWD (the launcher starts the
 * bridge a moment before the TUI, so the next session in that directory is
 * ours). Zero dependencies, same as the hub and the channel.
 *
 *   CHILLACKS_AGENT=astra CODEX_THREAD=<uuid> node codex-bridge.mjs
 *   CHILLACKS_AGENT=sol CODEX_CWD=C:\...\workspace node codex-bridge.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";

const SEAT = process.env.CHILLACKS_AGENT || "";
if (!SEAT) {
  console.error("[codex-bridge] CHILLACKS_AGENT is required (the seat name)");
  process.exit(2);
}
const HUB =
  process.env.CHILLACKS_HUB ||
  `http://${process.env.CHILLACKS_HOST || "127.0.0.1"}:${process.env.CHILLACKS_PORT || 8790}`;
const CWD = process.env.CODEX_CWD || process.cwd();
const STARTED = Date.now();

function readToken() {
  // The store first, by seat name. A CHILLACKS_TOKEN inherited from the shell that
  // launched us is usually the LAUNCHING seat's (a Claude session started by
  // launch.ps1 exports its own), and the hub answers 403 "token is for X, not
  // <seat>" to a stream opened with it. The environment is the fallback only.
  const dir = process.env.CHILLACKS_ARCHIVE || path.join(os.homedir(), ".stewards", "chillacks");
  const file = process.env.CHILLACKS_TOKENS || path.join(dir, "tokens.json");
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    const v = d[SEAT];
    const t = typeof v === "string" ? v : v && v.token ? v.token : "";
    if (t) return t;
  } catch {}
  return process.env.CHILLACKS_TOKEN || "";
}
const TOKEN = readToken();
if (!TOKEN) {
  console.error(`[codex-bridge] no token for seat ${SEAT}; mint it: node tokens.mjs add ${SEAT}`);
  process.exit(2);
}
const headers = { "x-chillacks-token": TOKEN };
// One listener per seat: leave a pid file so a launcher can stop a previous bridge
// for this seat instead of two of them fighting for the stream (the hub evicts the
// older stream on reconnect, and both retry forever).
try {
  const logs = path.join(process.env.CHILLACKS_ARCHIVE || path.join(os.homedir(), ".stewards", "chillacks"), "logs");
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, `bridge-${SEAT}.pid`), String(process.pid));
} catch {}

// --- which Codex thread is ours ---------------------------------------------
function sessionsRoot() {
  return process.env.CODEX_HOME
    ? path.join(process.env.CODEX_HOME, "sessions")
    : path.join(os.homedir(), ".codex", "sessions");
}
function* rolloutFiles(root) {
  let years = [];
  try { years = fs.readdirSync(root); } catch { return; }
  for (const y of years) for (const m of safeList(path.join(root, y)))
    for (const d of safeList(path.join(root, y, m)))
      for (const f of safeList(path.join(root, y, m, d)))
        if (f.endsWith(".jsonl")) yield path.join(root, y, m, d, f);
}
function safeList(p) { try { return fs.readdirSync(p); } catch { return []; } }
function sessionMeta(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    const first = buf.toString("utf8", 0, n).split("\n")[0];
    const j = JSON.parse(first);
    return j.type === "session_meta" ? j.payload : null;
  } catch {
    return null;
  }
}
function norm(p) { return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); }
async function discoverThread() {
  if (process.env.CODEX_THREAD) return process.env.CODEX_THREAD;
  const root = sessionsRoot();
  const deadline = Date.now() + 120_000;
  console.error(`[codex-bridge] ${SEAT}: waiting for a new Codex session in ${CWD} (up to 120 s)`);
  while (Date.now() < deadline) {
    let best = null;
    for (const f of rolloutFiles(root)) {
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      if (st.birthtimeMs < STARTED - 5_000 && st.mtimeMs < STARTED - 5_000) continue;
      const meta = sessionMeta(f);
      if (!meta || norm(meta.cwd) !== norm(CWD)) continue;
      const id = meta.session_id || meta.id;
      if (!id) continue;
      if (!best || st.birthtimeMs > best.t) best = { id, t: st.birthtimeMs, f };
    }
    if (best) {
      console.error(`[codex-bridge] ${SEAT}: bound to thread ${best.id} (${path.basename(best.f)})`);
      return best.id;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.error(`[codex-bridge] ${SEAT}: no new Codex session appeared in ${CWD}; set CODEX_THREAD explicitly`);
  process.exit(3);
}

// --- how to call codex without a shell ----------------------------------------
// On Windows `codex` is an npm .cmd shim; running it through cmd.exe mangles a
// multi-line --message (quotes, brackets) into a usage error. Resolve the shim
// to its JavaScript entry and call node directly. CODEX_BIN overrides.
function resolveCodex() {
  if (process.env.CODEX_BIN) return { file: process.env.CODEX_BIN, prefix: [] };
  if (process.platform !== "win32") return { file: "codex", prefix: [] };
  try {
    const out = execFileSync("where", ["codex"], { encoding: "utf8" });
    const found = out.split(String.fromCharCode(10)).map((x) => x.replace(String.fromCharCode(13), "").trim()).filter(Boolean);
    const cmd = found.find((x) => x.toLowerCase().endsWith(".cmd"));
    if (cmd) {
      const js = path.join(path.dirname(cmd), "node_modules", "@openai", "codex", "bin", "codex.js");
      if (fs.existsSync(js)) return { file: process.execPath, prefix: [js] };
    }
  } catch {}
  return { file: "codex", prefix: [] };
}
const CODEX = resolveCodex();
console.error(`[codex-bridge] ${SEAT}: codex via ${CODEX.prefix[0] || CODEX.file}`);

// --- forwarding, one at a time, in order -------------------------------------
const pending = [];
let draining = false;
function enqueue(thread, text) {
  pending.push(text);
  if (!draining) drain(thread);
}
async function drain(thread) {
  draining = true;
  while (pending.length) {
    const text = pending.shift();
    await new Promise((resolve) => {
      execFile(
        CODEX.file,
        [...CODEX.prefix, "queue", "--thread", thread, "--message", text],
        { windowsHide: true },
        (err, stdout, stderr) => {
          if (err) console.error(`[codex-bridge] ${SEAT}: queue failed: ${String(stderr || err.message).trim().slice(0, 200)}`);
          else console.error(`[codex-bridge] ${SEAT}: queued (${String(stdout).trim().slice(0, 80)})`);
          resolve();
        },
      );
    });
  }
  draining = false;
}

function render(msg) {
  const scope = msg.to ? (msg.kind === "ack" ? "ack" : "DM") : msg.channel ? `#${msg.channel}` : "room";
  return (
    `[chillacks ${scope}] from ${msg.from} (msg #${msg.id}${msg.ref ? `, ref #${msg.ref}` : ""}): ${msg.text}\n\n` +
    `(Delivered by the codex-bridge. You are the chillacks seat "${SEAT}". Read it, do what it asks within your brief and the seat protocol, ` +
    `and reply with chillacks_send to the sender; silence is acknowledgement between seats unless a reply is asked for.)`
  );
}

// --- the stream, retrying forever, same shape as channel.mjs -----------------
async function listen(thread) {
  const res = await fetch(`${HUB}/stream?agent=${encodeURIComponent(SEAT)}`, { headers });
  if (!res.ok) throw new Error(`stream ${res.status}`);
  console.error(`[codex-bridge] ${SEAT} joined the room as its listener; forwarding to thread ${thread}`);
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
        if (msg.from === SEAT) continue; // our own words, echoed
        if (msg.kind === "ack") continue; // acks never wake a seat
        enqueue(thread, render(msg));
      }
    }
  }
  throw new Error("stream ended");
}

async function run() {
  const thread = await discoverThread();
  let delay = 1000;
  for (;;) {
    try {
      await listen(thread);
      delay = 1000;
    } catch (e) {
      console.error(`[codex-bridge] ${SEAT}: ${e.message}; retry in ${delay} ms`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15_000);
    }
  }
}
run();

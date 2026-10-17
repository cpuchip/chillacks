#!/usr/bin/env node
/* chillacks hub — the room.
 *
 * Agents do NOT bind ports. Each one dials out to this hub over SSE and POSTs
 * to send. That is deliberate: per-agent listeners would need port allocation,
 * and a stale process holding a port is exactly how the :9100 crash-loop
 * happened. One port, held by one process, is the whole surface.
 *
 * Zero dependencies — node:http only.
 *
 *   node hub.mjs
 *
 * Env:
 *   CHILLACKS_HOST   bind address (default 127.0.0.1)
 *   CHILLACKS_PORT   default 8790
 *   CHILLACKS_TOKEN  shared secret; REQUIRED when host is not loopback
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { URL } from "node:url";
import { newLedger, decide, apply, sweep, view } from "./claims.mjs";

const HOST = process.env.CHILLACKS_HOST || "127.0.0.1";
const PORT = Number(process.env.CHILLACKS_PORT || 8790);
const TOKEN = process.env.CHILLACKS_TOKEN || "";

// The room is live and ephemeral; the archive is the record. Processes die —
// we watched the hub die with a CLI exit and take the whole room with it — so
// every message is appended to disk before it is delivered.
const ARCHIVE_DIR =
  process.env.CHILLACKS_ARCHIVE || path.join(os.homedir(), ".stewards", "chillacks");
const ARCHIVE = path.join(ARCHIVE_DIR, "room.jsonl");

// Every log line carries a UTC stamp. Without one an eviction storm cannot be
// dated after the fact: one log held 118 reconnect lines and no way to say
// which nights they belonged to (2026-09-22).
const stderr = console.error.bind(console);
console.error = (...a) => stderr(new Date().toISOString(), ...a);

const LOOPBACK = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";

// Anything that still escapes is logged with a timestamp before the process
// ends, so the log says why the room went down.
process.on("uncaughtException", (e) => {
  console.error(`[chillacks] ! uncaught, exiting: ${e?.stack || e}`);
  process.exit(1);
});

// Refuse to go wide open. Binding the mesh IP without a token would put an
// unauthenticated text pipe in front of sessions running --dangerously-skip-permissions.
if (!LOOPBACK && !TOKEN) {
  console.error(
    `chillacks: refusing to bind ${HOST} without CHILLACKS_TOKEN.\n` +
      `An ungated channel is a prompt-injection vector. Set a token or bind 127.0.0.1.`,
  );
  process.exit(2);
}

/** name -> Set of { write(msg), end(), joined, authed, kind: 'sse'|'ws' }.
 *  One name may hold several streams (2026-09-22). A newer stream used to
 *  EVICT the older one, and a session that could not hear (a scheduled run
 *  that inherited the seat name from its environment) took the seat from the
 *  one that could: a DM counted as delivered reached nobody. Now every stream
 *  a name holds receives, a recipient is counted once, and a stream leaves
 *  only when its socket does. */
const members = new Map();
const history = [];
const HISTORY_MAX = 200;
let seq = 0;
/** every name that has ever sent (archive included); see knownNames() */
const seen = new Set();

function addStream(name, m) {
  let set = members.get(name);
  if (!set) members.set(name, (set = new Set()));
  set.add(m);
  const tag = m.kind === "ws" ? " (ws)" : "";
  console.error(`[chillacks] + ${name}${tag}  (${members.size} present)`);
  // a batch whose window closed while this seat had no stream goes now
  if (held.get(name)?.pending) setImmediate(() => flush(name));
  if (set.size > 1)
    console.error(
      `[chillacks] ! ${name} holds ${set.size} streams, all receive; if this persists, a second session is carrying this seat name`,
    );
}

function dropStream(name, m) {
  const set = members.get(name);
  if (!set?.delete(m)) return; // already gone (end() and close both land here)
  if (!set.size) members.delete(name);
  const tag = m.kind === "ws" ? " (ws)" : "";
  const rest = set.size ? `, ${set.size} stream(s) remain` : "";
  console.error(`[chillacks] - ${name}${tag}  (${members.size} present${rest})`);
}

// --- channels: working groups, so a message wakes the seats it concerns -----
// The night-orders retro measured the cost of broadcast-as-default: every
// message woke eight contexts, most to no-op. A channel scopes DELIVERY, not
// secrecy — any agent may post to any channel; membership decides who wakes.
// #all is implicit and always everyone.
/** channel -> Set(agent name) */
const channels = new Map();
const CHANNELS_FILE =
  process.env.CHILLACKS_CHANNELS || path.join(ARCHIVE_DIR, "channels.json");

function loadChannels() {
  if (!fs.existsSync(CHANNELS_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8"));
    for (const [ch, names] of Object.entries(raw))
      if (Array.isArray(names) && names.length) channels.set(ch, new Set(names));
  } catch (e) {
    console.error(`[chillacks] channels.json unreadable (${e.message}) — starting with none`);
  }
}
function saveChannels() {
  try {
    fs.writeFileSync(
      CHANNELS_FILE,
      JSON.stringify(Object.fromEntries([...channels].map(([c, s]) => [c, [...s]])), null, 2),
    );
  } catch (e) {
    console.error(`[chillacks] channels.json write failed: ${e.message}`);
  }
}
loadChannels();

// --- quiet windows: several DMs to one seat become one wake ------------------
// A seat that asked five others a question was woken five times in a minute by
// the answers. A window holds a seat's DMs and acks for N seconds after the
// first, then delivers them as one. Channels and #all are never held: they
// carry rulings and blockers. Persisted like channels, so a restart keeps it.
const QUIET_FILE = process.env.CHILLACKS_QUIET || path.join(ARCHIVE_DIR, "quiet.json");
const QUIET_MAX_S = 900;
/** name -> seconds */
const quiet = new Map();
/** name -> { msgs: [], timer } */
const held = new Map();
try {
  if (fs.existsSync(QUIET_FILE))
    for (const [n, sec] of Object.entries(JSON.parse(fs.readFileSync(QUIET_FILE, "utf8"))))
      if (Number.isFinite(sec) && sec > 0 && sec <= QUIET_MAX_S) quiet.set(n, sec);
} catch (e) {
  console.error(`[chillacks] quiet.json unreadable (${e.message}) — starting with no windows`);
}
function saveQuiet() {
  try {
    fs.writeFileSync(QUIET_FILE, JSON.stringify(Object.fromEntries(quiet), null, 2));
  } catch (e) {
    console.error(`[chillacks] quiet.json write failed: ${e.message}`);
  }
}

// --- the wake log: one line per delivery the hub actually makes -------------
// The archive says what was sent; once a window folds five DMs into one, it can
// no longer say how many times a seat was woken. This file can.
const WAKES = process.env.CHILLACKS_WAKES || path.join(ARCHIVE_DIR, "wakes.jsonl");
/** Holds and drops are logged beside the wakes (lines with `held` or
 *  `dropped`, never `ids`), so a restarted hub delivers what was held and
 *  neither delivered nor dropped. Only a line with `ids` is a wake. */
function logHeld(to, field, ids) {
  try {
    fs.appendFileSync(WAKES, JSON.stringify({ ts: new Date().toISOString(), to, [field]: ids }) + "\n");
  } catch (e) {
    console.error(`[chillacks] wakes.jsonl write failed: ${e.message}`);
  }
}
// A held message older than this when its recipient can finally be reached is
// dropped (it stays in the archive); a restart recovers nothing older either.
const HELD_MAX_S = Number(process.env.CHILLACKS_HELD_MAX_S || 1800);
/** recent DMs and acks by id, filled while the archive loads, for recovery */
const recentDMs = new Map();

function logWake(to, ids) {
  try {
    fs.appendFileSync(WAKES, JSON.stringify({ ts: new Date().toISOString(), to, ids }) + "\n");
  } catch (e) {
    console.error(`[chillacks] wakes.jsonl write failed: ${e.message}`);
  }
}

/** each seat's latest status: name -> { id, text, ts } */
const latestStatus = new Map();

// --- claims: a lease on a shared thing, so an open call can't summon six ----
// Seven seats converged on one test file from "whoever's awake". A claim is
// mechanics-not-memory: first claimant holds the lease, everyone else is told
// who has it. A claim may also name a box, a cap and minutes, and then the
// sum of caps on the box stays under the box's budget (claims.mjs, and
// docs/ledger.md for the design).
//
// Claims were ephemeral until 2026-10-16: a restart cleared them. A budget
// cannot work that way (a restart would forget a running job and grant past
// it), so grants and releases are archived and replayed on start.
const FOREMAN = process.env.CHILLACKS_FOREMAN || "workspace-basecamp";
const ledger = newLedger({}, { foreman: FOREMAN });
/** archive kinds that are records, not messages: never delivered, never in history */
const LEDGER_KINDS = new Set(["claim", "release", "claim-refused"]);

// The budget table is a household's rulings, so it lives beside the archive,
// not in the repo. Reloaded on change; an unreadable file keeps the last good
// table, so a half-written edit cannot open every box.
const BUDGETS_FILE = process.env.CHILLACKS_BUDGETS || path.join(ARCHIVE_DIR, "budgets.json");
function loadBudgets() {
  if (!fs.existsSync(BUDGETS_FILE)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(BUDGETS_FILE, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
    ledger.budgets = raw;
    console.error(`[chillacks] budgets: ${Object.keys(raw).join(", ") || "(none)"}`);
    // an unusable row refuses every claim on its box; say so now, not at the first claim
    for (const [box, v] of Object.entries(view(ledger, Date.now()).boxes))
      if (v.invalid) console.error(`[chillacks] ! budget row ${box} is unusable (${v.invalid}) — claims on it are refused`);
    return true;
  } catch (e) {
    console.error(`[chillacks] ! budgets.json unreadable (${e.message}) — KEEPING the previous table`);
    return false;
  }
}
loadBudgets();

const normChannel = (s) => String(s || "").toLowerCase().replace(/^#/, "").trim();

/** @name tokens that match a KNOWN agent (roster or token file). A mention
 *  reaches across channel boundaries; an unknown @word is just prose. */
function mentionsIn(text) {
  const names = new Set([...members.keys(), ...tokenToName.values()]);
  const out = new Set();
  for (const m of String(text).matchAll(/@([a-z0-9][a-z0-9_-]*)/gi))
    if (names.has(m[1])) out.add(m[1]);
  return [...out];
}

/** Every name the hub could address: present, token-holding, in a channel, or
 *  has ever sent. Absent-but-known reads as "archived, they catch up later";
 *  unknown is a typo or a nickname nobody registered, and must say so. */
function knownNames() {
  const names = new Set([...members.keys(), ...tokenToName.values(), ...seen]);
  for (const s of channels.values()) for (const n of s) names.add(n);
  return names;
}
const isKnown = (name) => knownNames().has(name);

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Up to three known names that contain, are contained by, or sit within two
 *  edits of the target: a shortened seat name finds its long form. */
function nearestNames(target) {
  const t = String(target).toLowerCase();
  const out = [];
  for (const n of knownNames()) {
    const l = n.toLowerCase();
    if (l.includes(t) || t.includes(l) || editDistance(l, t) <= 2) out.push(n);
  }
  return out.slice(0, 3);
}

// --- archive: append-only, never rewritten -------------------------------
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

/** A crash mid-append leaves a last line with no newline, and the next append
 *  would join it: both would then be skipped as one bad line. In room.jsonl
 *  that loses a grant; in wakes.jsonl a delivery, so a recovered DM is sent
 *  again. End the torn line first; its bytes stay, on a line of their own. */
function endTornLine(file, raw) {
  if (raw.length && !raw.endsWith("\n")) {
    fs.appendFileSync(file, "\n");
    console.error(`[chillacks] ${path.basename(file)}: last line had no newline (a torn write) — ended it before appending`);
  }
}

function loadArchive() {
  if (!fs.existsSync(ARCHIVE)) return 0;
  const raw = fs.readFileSync(ARCHIVE, "utf8");
  endTornLine(ARCHIVE, raw);
  const lines = raw.split("\n").filter(Boolean);
  let bad = 0;
  for (const line of lines) {
    try {
      const m = JSON.parse(line);
      if (m.from) seen.add(String(m.from));
      if (m.kind === "status") latestStatus.set(String(m.from), { id: m.id, text: m.text, ts: m.ts });
      if (m.id > seq) seq = m.id;
      if (LEDGER_KINDS.has(m.kind)) apply(ledger, m); // replay; a refusal changes nothing
      else history.push(m);
      if (m.to && m.id && Date.parse(m.ts) >= Date.now() - HELD_MAX_S * 1000) recentDMs.set(m.id, m);
    } catch {
      bad++; // a torn final write survives as one skipped line, not a dead hub
    }
  }
  while (history.length > HISTORY_MAX) history.shift();
  if (bad) console.error(`[chillacks] archive: skipped ${bad} unparseable line(s)`);
  return lines.length;
}

/** Append one record. Returns true when it is in the file. `sync` also
 *  fsyncs it: a ledger grant is state, and a grant lost to a power cut after
 *  its 200 is a running job the budget no longer counts. */
function archive(msg, { sync = false } = {}) {
  // Append before delivering. A message the room saw but the record didn't
  // would make the archive a liar, which is worse than a slow write.
  let fd = null;
  try {
    fd = fs.openSync(ARCHIVE, "a");
    fs.writeSync(fd, JSON.stringify(msg) + "\n");
    if (sync) fs.fsyncSync(fd);
    return true;
  } catch (e) {
    console.error(`[chillacks] ARCHIVE WRITE FAILED: ${e.message}`);
    return false;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
}

const restored = loadArchive();
sweep(ledger, Date.now());
recoverHeld();

/** After a crash: what was held (a `held` line) and never delivered (no wake
 *  line carries its id) waits for its seat's next connection. By set of ids:
 *  an #all delivered after a held DM must not mark the DM delivered. */
function recoverHeld() {
  if (!fs.existsSync(WAKES)) return;
  const raw = fs.readFileSync(WAKES, "utf8");
  endTornLine(WAKES, raw);
  const heldIds = new Map(), done = new Map();
  for (const line of raw.split("\n")) {
    let w;
    try { w = JSON.parse(line); } catch { continue; }
    if (!w?.to) continue;
    const into = w.held ? heldIds : done;
    if (!into.has(w.to)) into.set(w.to, new Set());
    for (const id of w.held || w.ids || w.dropped || []) into.get(w.to).add(id); // a drop is settled too
  }
  for (const [name, ids] of heldIds) {
    const msgs = [...ids]
      .filter((id) => !done.get(name)?.has(id))
      .map((id) => recentDMs.get(id))
      .filter(Boolean)
      .sort((a, b) => a.id - b.id);
    if (!msgs.length) continue;
    held.set(name, { msgs, timer: null, pending: true });
    console.error(`[chillacks] recovered ${msgs.length} held message(s) for ${name}; delivered at its next connection`);
  }
  recentDMs.clear();
}

/** Archive a ledger record. It is the record of a grant, a release or a
 *  refusal, so it gets an id like any message, and it is delivered to nobody
 *  and kept out of history: a seat catching up reads the conversation. */
function ledgerRecord(fields, { sync = false } = {}) {
  const size = (() => { try { return fs.statSync(ARCHIVE).size; } catch { return 0; } })();
  const msg = { id: ++seq, to: null, channel: null, ...fields, ts: new Date().toISOString() };
  const ok = archive(msg, { sync });
  // Nothing reached the file: take the id back, so the archive shows no gap
  // for a record that was never made. A partial write keeps its id.
  if (!ok && (() => { try { return fs.statSync(ARCHIVE).size === size; } catch { return true; } })()) seq--;
  else seen.add(msg.from);
  return { msg, ok };
}

function claimText(r) {
  return r.box ? `claim ${r.resource} on ${r.box}, ${r.cap_gib} GiB, ${r.minutes} min` : `claim ${r.resource} (${r.minutes} min)`;
}

// --- identity -------------------------------------------------------------
// Names used to be self-asserted. That was tolerable while peers only traded
// data; once a peer message became a work order — and a message from the
// FOREMAN became direction — a forgeable `from` became a forgeable authority.
// Identity is now derived from a bearer token the hub maps to a name, and the
// client's claimed `from` is ignored entirely.
const TOKENS_FILE = process.env.CHILLACKS_TOKENS || path.join(ARCHIVE_DIR, "tokens.json");
let tokenToName = new Map();

let AUTH = false;

/** Read tokens from disk. Returns false if nothing usable was found.
 *
 * Deliberately NEVER downgrades. Once the hub is enforcing identity it stays
 * enforcing: an empty, deleted, or corrupt tokens file keeps the last known
 * good set and complains, rather than silently reopening the room. Getting
 * safer without a restart is a convenience; getting *less* safe without one is
 * a footgun, and the two are not symmetric. */
function loadTokens({ initial = false } = {}) {
  let next = new Map();
  if (fs.existsSync(TOKENS_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
      for (const [name, tok] of Object.entries(raw)) {
        if (typeof tok === "string" && tok.length >= 16) next.set(tok, name);
      }
    } catch (e) {
      if (initial) {
        console.error(`[chillacks] tokens.json unreadable (${e.message}) — REFUSING to run open`);
        process.exit(2);
      }
      console.error(`[chillacks] ! tokens.json unreadable (${e.message}) — KEEPING the previous set`);
      return false;
    }
  }

  if (next.size === 0) {
    if (AUTH) {
      console.error(
        `[chillacks] ! tokens.json is now empty — REFUSING to disable identity. ` +
          `Restart the hub deliberately if that is really what you want.`,
      );
    }
    return false;
  }

  const added = [...next.values()].filter((n) => ![...tokenToName.values()].includes(n));
  tokenToName = next;
  if (!AUTH) {
    AUTH = true;
    if (!initial) console.error(`[chillacks] identity ENABLED live — ${next.size} agent(s)`);
  }
  if (added.length && !initial) console.error(`[chillacks] + token(s) for: ${added.join(", ")}`);
  return true;
}
loadTokens({ initial: true });

if (!LOOPBACK && !AUTH) {
  console.error(`chillacks: refusing to bind ${HOST} without per-agent tokens.`);
  process.exit(2);
}

// Watch the DIRECTORY, not the file: an editor or a writer that replaces rather
// than truncates would break a file watch, and the file may not exist yet.
let reloadTimer = null;
try {
  fs.watch(ARCHIVE_DIR, (_evt, file) => {
    if (file !== path.basename(TOKENS_FILE)) return;
    clearTimeout(reloadTimer); // fs.watch fires several times per write
    reloadTimer = setTimeout(() => {
      const before = AUTH;
      if (loadTokens() && !before) dropUnauthenticated();
    }, 150);
  });
} catch (e) {
  console.error(`[chillacks] could not watch ${ARCHIVE_DIR} (${e.message}) — tokens need a restart`);
}
let budgetTimer = null;
try {
  fs.watch(path.dirname(BUDGETS_FILE), (_evt, file) => {
    if (file !== path.basename(BUDGETS_FILE)) return;
    clearTimeout(budgetTimer);
    budgetTimer = setTimeout(loadBudgets, 150);
  });
} catch (e) {
  console.error(`[chillacks] could not watch ${path.dirname(BUDGETS_FILE)} (${e.message}) — budgets need a restart`);
}

/** When identity turns on mid-flight, streams opened while the room was open
 *  are still connected and still unauthenticated. Close them; every shim
 *  retries with backoff, so they come back properly identified within seconds. */
function dropUnauthenticated() {
  let n = 0;
  for (const [name, set] of [...members])
    for (const m of [...set]) {
      if (m.authed) continue;
      m.end();
      dropStream(name, m);
      n++;
    }
  if (n) console.error(`[chillacks] dropped ${n} pre-identity stream(s) — they will reconnect with tokens`);
}

/** The authenticated name, or null. Never trust a name off the wire. */
function identify(req) {
  const t = req.headers["x-chillacks-token"];
  return t ? tokenToName.get(t) ?? null : null;
}

/** Refuse anything a browser could have sent.
 *
 * DEMONSTRATED 2026-07-27, not theoretical: a cross-origin POST carrying
 * `content-type: text/plain` is a CORS "simple request", so there is no
 * preflight to fail. It was accepted, impersonated the foreman, and was
 * delivered to a steward — the page cannot read the reply, but the injection
 * already happened. Any tab is enough; no compromise required.
 *
 * Browsers always attach Origin to a cross-origin request and cannot suppress
 * it. Local clients never send one. Requiring JSON on top forces a preflight
 * that fails for want of CORS headers, so this holds even if Origin were ever
 * absent. */
function browserish(req) {
  if (req.headers.origin) return "Origin header present";
  if (req.method === "POST") {
    const ct = String(req.headers["content-type"] || "");
    if (!ct.startsWith("application/json")) return "content-type is not application/json";
  }
  return null;
}

function deliver(msg, { echo = false } = {}) {
  let targets;
  if (msg.to) {
    targets = new Set([msg.to]); // direct message
  } else if (msg.channel) {
    targets = new Set(channels.get(msg.channel) || []);
    for (const m of msg.mentions || []) targets.add(m); // mentions cross channels
  } else {
    targets = new Set(members.keys()); // #all
  }
  let n = 0;
  for (const name of targets) {
    if (name === msg.from && !echo) continue; // normally don't echo to sender
    const set = members.get(name);
    if (!set?.size) continue; // the room archives but does not queue — absent means missed
    if (msg.to && quiet.has(name) && !echo) {
      hold(name, msg); // counted: it will be delivered when the window closes
      n++;
      continue;
    }
    for (const m of set) m.write(msg); // every stream the name holds, one recipient
    logWake(name, [msg.id]);
    n++;
  }
  return n; // actual deliveries, not a guess from roster size
}

function hold(name, msg) {
  let h = held.get(name);
  if (!h) {
    h = { msgs: [], timer: setTimeout(() => flush(name), quiet.get(name) * 1000) };
    held.set(name, h);
  }
  h.msgs.push(msg);
  logHeld(name, "held", [msg.id]);
}

/** Deliver what a window held: the message itself when there was one, else
 *  one digest from `chillacks` listing each by id, so each can still be acked.
 *  The originals are already archived; the digest is a delivery, not a
 *  message, so it is not. A seat that left during the window reads them with
 *  chillacks_recent, as it would any message sent while it was away. */
function flush(name) {
  const h = held.get(name);
  if (!h) return;
  clearTimeout(h.timer);
  h.timer = null;
  const set = members.get(name);
  if (!set?.size) {
    // The sender was told "delivered"; keep the batch for the seat's return.
    if (!h.pending) console.error(`[chillacks] ${name} is away; ${h.msgs.length} held message(s) wait for its next connection`);
    h.pending = true;
    return;
  }
  held.delete(name);
  const cutoff = Date.now() - HELD_MAX_S * 1000;
  const fresh = h.msgs.filter((m) => Date.parse(m.ts) >= cutoff);
  if (fresh.length < h.msgs.length) logHeld(name, "dropped", h.msgs.filter((m) => !fresh.includes(m)).map((m) => m.id));
  if (fresh.length < h.msgs.length)
    console.error(
      `[chillacks] ${name}: dropped ${h.msgs.length - fresh.length} held message(s) older than ${HELD_MAX_S} s; they are in the archive`,
    );
  if (!fresh.length) return;
  h.msgs = fresh;
  const ids = h.msgs.map((m) => m.id);
  const out =
    h.msgs.length === 1
      ? h.msgs[0]
      : {
          id: null,
          from: "chillacks",
          to: name,
          kind: "digest",
          ids,
          text:
            `${h.msgs.length} messages held by your quiet window:\n` +
            h.msgs
              .map((m) => `#${m.id} ${m.from}${m.kind === "ack" ? ` [ack #${m.ref}]` : ""}: ${m.text}`)
              .join("\n"),
          ts: new Date().toISOString(),
        };
  for (const m of set) m.write(out);
  logWake(name, ids);
  console.error(`[chillacks] quiet window for ${name}: ${ids.length} message(s) as one`);
}

// --- /ws: the native-WebSocket door (2026-08-10, Michael's ruling) ----------
// Claude Code's Monitor tool can hold a ws subscription and be WOKEN per
// inbound frame with zero MCP config — but its contract has no headers, so a
// bearer must ride the Sec-WebSocket-Protocol line. A long-lived token in a
// tool call lands in the session transcript (we measured that failure the
// same hour this was built), so the door prefers TICKETS: POST /ws-ticket
// with the normal header token mints a single-use 60s ticket; the ticket is
// safe to show a transcript because it is dead the moment it is used.
// Still zero dependencies: the server side of RFC6455 is a SHA-1 handshake,
// an unmasked text-frame writer, and a masked-frame reader for close/ping.
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** ticket -> { name, expires } */
const wsTickets = new Map();

function mintWsTicket(name) {
  const t = crypto.randomBytes(18).toString("base64url");
  wsTickets.set(t, { name, expires: Date.now() + 60_000 });
  return t;
}

function takeWsTicket(t) {
  const e = wsTickets.get(t);
  if (!e) return null;
  wsTickets.delete(t); // single-use, even when expired
  return e.expires >= Date.now() ? e.name : null;
}

setInterval(() => {
  const now = Date.now();
  for (const [t, e] of wsTickets) if (e.expires < now) wsTickets.delete(t);
}, 30_000).unref();

function wsTextFrame(str) {
  const p = Buffer.from(String(str), "utf8");
  let h;
  if (p.length < 126) h = Buffer.from([0x81, p.length]);
  else if (p.length < 65536) {
    h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2);
  } else {
    h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2);
  }
  return Buffer.concat([h, p]);
}

const WS_PING = Buffer.from([0x89, 0x00]);
const WS_MAX_FRAME = 1 << 20;
const WS_CLOSE = Buffer.from([0x88, 0x00]);

/** Feed inbound bytes; handle close (echo + done) and ping (pong). Data
 * frames are IGNORED — the ws door is receive-only; sends stay on POST /send
 * where the header token already authorizes them. Returns true when the
 * socket should close. */
function wsConsume(state, chunk, sock) {
  state.buf = state.buf.length ? Buffer.concat([state.buf, chunk]) : chunk;
  for (;;) {
    const b = state.buf;
    if (b.length < 2) return false;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return false; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return false; len = Number(b.readBigUInt64BE(2)); off = 10; }
    // A client only ever sends control frames here (close, ping), so a frame past
    // the cap is closed on rather than buffered: the length is the client's word.
    if (len > WS_MAX_FRAME) return true;
    const maskOff = off, dataOff = masked ? off + 4 : off;
    if (b.length < dataOff + len) return false;
    let payload = b.subarray(dataOff, dataOff + len);
    if (masked) {
      const key = b.subarray(maskOff, maskOff + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
    }
    state.buf = b.subarray(dataOff + len);
    if (opcode === 0x8) { try { sock.write(WS_CLOSE); } catch {} return true; }
    if (opcode === 0x9) { try { sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); } catch {} }
    // 0xA pong and all data frames: ignored on purpose.
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

// A throw inside a route used to be an unhandled rejection, which ended the
// process and dropped every seat: a JSON body of `null` was enough (it parses,
// and the first field read throws). Now a throw is logged with its route and
// answered 500, and the room carries on.
const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (e) {
    console.error(`[chillacks] ! ${req.method} ${String(req.url).split("?")[0]} threw: ${e?.stack || e}`);
    try {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "the hub hit an error on this request; it is in the hub's log" }));
      } else res.end();
    } catch {}
  }
});

async function route(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  const bad = browserish(req);
  if (bad) {
    console.error(`[chillacks] ! refused a browser-shaped request (${bad})`);
    return json(403, { error: `refused: ${bad}` });
  }

  const who = identify(req);
  if (AUTH && !who) return json(401, { error: "unknown or missing token" });

  // --- POST /ws-ticket : mint a single-use 60s ticket for the ws door ------
  // Authorized by the normal header token, so the long-lived secret stays in
  // config files; only the disposable ticket ever appears in a tool call.
  if (req.method === "POST" && url.pathname === "/ws-ticket") {
    if (AUTH && !who) return json(401, { error: "unknown or missing token" });
    if (!who && !AUTH) return json(400, { error: "ws tickets need identity; run the hub with tokens" });
    const ticket = mintWsTicket(who);
    return json(200, {
      ticket, expires_in: 60,
      // Offer the constant marker FIRST so the 101 echoes `chillacks`, not
      // the credential; the ticket rides second and is consumed, never echoed.
      subprotocols: ["chillacks", `chillacks.ticket.${ticket}`],
      connect: `/ws (subprotocols: chillacks, chillacks.ticket.${ticket})`,
    });
  }

  // --- GET /stream?agent=NAME : hold open, push messages -------------------
  if (req.method === "GET" && url.pathname === "/stream") {
    const claimed = url.searchParams.get("agent");
    if (!claimed) return json(400, { error: "agent required" });
    // Under auth the token names you; the query param may not disagree.
    if (AUTH && claimed !== who)
      return json(403, { error: `token is for "${who}", not "${claimed}"` });
    const name = AUTH ? who : claimed;

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    // Remember whether this stream proved who it was, so enabling identity
    // later can tell the pre-identity connections apart and close them.
    const m = {
      write: (msg) => { try { res.write(`data: ${JSON.stringify(msg)}\n\n`); } catch {} },
      end: () => res.end(),
      joined: Date.now(),
      authed: Boolean(who),
      kind: "sse",
    };
    addStream(name, m);

    // The ping is also the death detector. A peer that vanished without a FIN
    // (killed process, slept box, dropped NAT mapping) never acks it, the
    // kernel gives up after its retransmit limit, and `close` fires here.
    // Measured 2026-09-22 (network disconnect under an established socket,
    // Linux tcp_retries2=15): 963 s from vanish to drop; delivery to the
    // seat's live stream stayed immediate throughout. TCP keepalive is a belt
    // for a socket the ping is not writing to: while the ping runs the socket
    // is never idle, so keepalive does not arm and the retransmit limit rules.
    req.socket.setKeepAlive(true, 30_000);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25_000);
    req.on("close", () => {
      clearInterval(ping);
      dropStream(name, m);
    });
    return;
  }

  // --- POST /send : {from, to?, text} --------------------------------------
  if (req.method === "POST" && url.pathname === "/send") {
    let p;
    try {
      p = JSON.parse(await readBody(req));
    } catch {
      return json(400, { error: "bad json" });
    }
    if (!p.text) return json(400, { error: "text required" });
    // Under auth the sender is WHO THE TOKEN SAYS, never who the body claims.
    // Forgery is impossible by construction rather than by policing.
    const from = AUTH ? who : p.from;
    if (!from) return json(400, { error: "from required" });

    // A status is for the record: archived, shown on the roster, and delivered
    // to nobody. 124 FYIs woke the foreman in one week; they can be read instead.
    if (p.kind != null && p.kind !== "status") return json(400, { error: `unknown kind ${JSON.stringify(p.kind)}` });
    if (p.kind === "status") {
      if (p.to || p.channel)
        return json(400, { error: "a status is delivered to nobody; send a DM or a channel message instead" });
      const msg = { id: ++seq, from: String(from), to: null, channel: null, kind: "status", text: String(p.text), ts: new Date().toISOString() };
      archive(msg);
      seen.add(msg.from);
      history.push(msg);
      if (history.length > HISTORY_MAX) history.shift();
      latestStatus.set(msg.from, { id: msg.id, text: msg.text, ts: msg.ts });
      console.error(`[chillacks] ${msg.from} status: ${msg.text.slice(0, 80)}`);
      return json(200, { ok: true, id: msg.id, delivered_to: 0, status: true });
    }

    const channel = p.to ? null : p.channel ? normChannel(p.channel) : null;
    const msg = {
      id: ++seq,
      from: String(from),
      to: p.to ? String(p.to) : null,
      channel: channel && channel !== "all" ? channel : null,
      text: String(p.text),
      ts: new Date().toISOString(),
    };
    if (!msg.to) {
      const men = mentionsIn(msg.text);
      if (men.length) msg.mentions = men;
    }
    // echo=true delivers back to the sender too. Only the selftest uses it: a
    // session that is in .mcp.json but NOT named in the launch flag has working
    // tools and a dead ear, and this is the only way to tell from inside.
    archive(msg);
    seen.add(msg.from);
    history.push(msg);
    if (history.length > HISTORY_MAX) history.shift();
    const n = deliver(msg, { echo: p.echo === true });
    // A DM to a name the hub has never met is archived like any other, but the
    // sender must not read its "0 recipients" as "archived, they catch up":
    // six corrections once went to a shortened seat name that way (2026-09-18).
    const unknown = Boolean(msg.to) && n === 0 && !isKnown(msg.to);
    console.error(
      `[chillacks] ${msg.from} -> ${msg.to || (msg.channel ? "#" + msg.channel : "#all")} [${n}]${unknown ? " UNKNOWN SEAT" : ""}: ${msg.text.slice(0, 80)}`,
    );
    const heldFor = msg.to && n && quiet.has(msg.to) && p.echo !== true ? quiet.get(msg.to) : 0;
    return json(200, {
      ok: true,
      id: msg.id,
      delivered_to: n,
      ...(heldFor ? { held_s: heldFor } : {}),
      ...(unknown ? { unknown: true, suggest: nearestNames(msg.to) } : {}),
    });
  }

  // --- POST /quiet : {seconds} — hold my DMs and acks, deliver them as one ---
  if (req.method === "POST" && url.pathname === "/quiet") {
    let p;
    try {
      p = JSON.parse(await readBody(req));
    } catch {
      return json(400, { error: "bad json" });
    }
    const name = AUTH ? who : p.from;
    if (!name) return json(400, { error: "from required" });
    const sec = p.seconds;
    if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0 || sec > QUIET_MAX_S)
      return json(400, { error: `seconds must be a number from 0 to ${QUIET_MAX_S}` });
    if (sec === 0) {
      quiet.delete(name);
      flush(name); // what the window holds goes now
    } else quiet.set(name, sec);
    saveQuiet();
    console.error(`[chillacks] ${name} quiet window ${sec ? sec + " s" : "off"}`);
    return json(200, { ok: true, seconds: sec });
  }

  // --- POST /channel : {action: join|leave, channel} ------------------------
  if (req.method === "POST" && url.pathname === "/channel") {
    let p;
    try {
      p = JSON.parse(await readBody(req));
    } catch {
      return json(400, { error: "bad json" });
    }
    const name = AUTH ? who : p.from;
    if (!name) return json(400, { error: "from required" });
    const ch = normChannel(p.channel);
    if (!ch || ch === "all")
      return json(400, { error: "a real channel name is required (#all is implicit)" });
    const set = channels.get(ch) || new Set();
    if (p.action === "leave") {
      set.delete(name);
      if (set.size) channels.set(ch, set);
      else channels.delete(ch); // an empty working group is a finished one
    } else {
      set.add(name); // join creates — a working group forms by being joined
      channels.set(ch, set);
    }
    saveChannels();
    console.error(
      `[chillacks] ${name} ${p.action === "leave" ? "left" : "joined"} #${ch} (${set.size} member(s))`,
    );
    return json(200, { ok: true, channel: ch, members: [...(channels.get(ch) || [])] });
  }

  // --- POST /ack : {ref, note?} — reaches ONLY the acked message's sender ---
  if (req.method === "POST" && url.pathname === "/ack") {
    let p;
    try {
      p = JSON.parse(await readBody(req));
    } catch {
      return json(400, { error: "bad json" });
    }
    const from = AUTH ? who : p.from;
    if (!from) return json(400, { error: "from required" });
    const ref = Number(p.ref);
    const orig = history.find((m) => m.id === ref);
    if (!orig) return json(404, { error: `message ${ref} is not in live history` });
    const msg = {
      id: ++seq,
      from,
      to: orig.from, // an ack is a DM by construction — costless to the room
      kind: "ack",
      ref,
      text: p.note ? String(p.note) : `ack #${ref}`,
      ts: new Date().toISOString(),
    };
    archive(msg);
    history.push(msg);
    if (history.length > HISTORY_MAX) history.shift();
    const n = deliver(msg);
    console.error(`[chillacks] ${from} ack #${ref} -> ${orig.from}`);
    return json(200, { ok: true, id: msg.id, delivered_to: n });
  }

  // --- POST /claim : {resource, release?} — a 15-minute lease --------------
  if (req.method === "POST" && url.pathname === "/claim") {
    let p;
    try {
      p = JSON.parse(await readBody(req));
    } catch {
      return json(400, { error: "bad json" });
    }
    const from = AUTH ? who : p.from;
    if (!from) return json(400, { error: "from required" });
    const now = Date.now();
    sweep(ledger, now);
    const d = decide(
      ledger,
      { from, resource: p.resource, release: p.release === true, box: p.box, cap_gib: p.cap_gib, minutes: p.minutes },
      now,
    );
    if (!d.ok && d.code === "resource_required") return json(400, { error: d.reason });
    if (!d.ok) {
      ledgerRecord({
        from,
        kind: "claim-refused",
        code: d.code,
        resource: String(p.resource),
        ...(p.box != null ? { box: String(p.box) } : {}),
        route: d.route,
        text: `claim ${p.resource} refused: ${d.reason}`,
      });
      console.error(`[chillacks] ${from} refused ${p.resource} (${d.code}): ${d.reason}`);
      // a non-holder release stays a 403, as the old shim expects
      return json(d.code === "not_holder" ? 403 : 200, { ...d, error: d.reason });
    }
    const r = d.record;
    if (r.kind === "release") {
      // A release that the archive did not take still applies here; that fails
      // safe, since the lease comes back at the next start and refuses more.
      apply(ledger, ledgerRecord({ from, kind: "release", resource: r.resource, text: `release ${r.resource}` }, { sync: true }).msg);
      console.error(`[chillacks] ${from} released ${r.resource}`);
      return json(200, { ok: true, released: r.resource });
    }
    const { at: _at, ...fields } = r;
    const rec = ledgerRecord({ ...fields, text: claimText(r) }, { sync: true });
    if (!rec.ok) {
      // Granted but not recorded would be forgotten at the next start.
      console.error(`[chillacks] ${from} ${claimText(r)}: REFUSED, the archive did not take it`);
      return json(503, {
        ok: false,
        code: "not_recorded",
        reason: "the hub could not record this grant, so it was not made; try again",
        route: null,
        error: "not recorded",
      });
    }
    apply(ledger, rec.msg);
    console.error(`[chillacks] ${from} ${claimText(r)}`);
    return json(200, {
      ok: true,
      claimed: r.resource,
      box: r.box,
      cap_gib: r.cap_gib,
      minutes: r.minutes,
      since: r.since,
      expires: r.expires,
      ttl_minutes: r.minutes,
    });
  }

  // --- GET /channels --------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/channels") {
    return json(200, {
      channels: Object.fromEntries([...channels].map(([c, s]) => [c, [...s]])),
    });
  }

  // --- GET /roster ---------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/roster") {
    const now = Date.now();
    sweep(ledger, now);
    const v = view(ledger, now);
    return json(200, {
      members: [...members.keys()],
      count: members.size,
      messages: history.length,
      channels: Object.fromEntries([...channels].map(([c, s]) => [c, [...s]])),
      claims: Object.fromEntries(
        Object.entries(v.leases).map(([r, l]) => [
          r,
          { by: l.by, since: l.since, box: l.box, cap_gib: l.cap_gib, expires: l.expires },
        ]),
      ),
      budgets: v.boxes,
      quiet: Object.fromEntries(quiet),
      status: Object.fromEntries(
        [...latestStatus].map(([n, st]) => [n, { ...st, text: st.text.slice(0, 200) }]),
      ),
    });
  }

  // --- GET /history?limit=N&channel=NAME -----------------------------------
  if (req.method === "GET" && url.pathname === "/history") {
    const n = Math.min(Number(url.searchParams.get("limit") || 50), HISTORY_MAX);
    const chq = url.searchParams.get("channel");
    let msgs = history;
    if (chq) {
      const c = normChannel(chq);
      msgs =
        c === "all"
          ? history.filter((m) => !m.channel && !m.to)
          : history.filter((m) => m.channel === c);
    }
    return json(200, { messages: msgs.slice(-n) });
  }

  json(404, { error: "not found" });
}

// --- ws upgrade: GET /ws -----------------------------------------------------
// Auth, in order: single-use ticket subprotocol (chillacks.ticket.T — the
// Monitor path), bearer subprotocol (chillacks.bearer.TOKEN — for clients
// that keep the token out of transcripts some other way), header token (for
// real ws clients that can send headers, e.g. the codex bridge). The same
// browser wall as HTTP: an Origin header means a browser sent it — refuse.
// The upgrade handler is reached before any token is checked, so a throw in it
// (one raw request with an absolute-form target such as http://a:99999/ws made
// new URL() throw) ended the hub with no credential at all. It is wrapped like
// route(): logged, refused 400, the room carries on.
server.on("upgrade", (req, socket, head) => {
  try {
    upgradeRoute(req, socket, head);
  } catch (e) {
    console.error(`[chillacks] ! ws upgrade threw: ${e?.stack || e}`);
    try { socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); } catch {}
    socket.destroy();
  }
});

function upgradeRoute(req, socket, head) {
  const refuse = (code, why) => {
    console.error(`[chillacks] ! ws refused (${why})`);
    try { socket.write(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); } catch {}
    socket.destroy();
  };
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname !== "/ws") return refuse(404, `no upgrade at ${url.pathname}`);
  if (req.headers.origin) return refuse(403, "Origin header present");
  const key = req.headers["sec-websocket-key"];
  if (!key || String(req.headers.upgrade || "").toLowerCase() !== "websocket")
    return refuse(400, "not a websocket upgrade");

  // Two auth paths, both keeping the CREDENTIAL out of anything logged or
  // echoed (codex/GPT-5.6's consult, 2026-08-10): a single-use ticket in the
  // subprotocol (the Monitor path — no headers available there), or a header
  // token for real ws clients. A LONG-LIVED bearer in the subprotocol was
  // removed: Sec-WebSocket-Protocol is commonly logged and echoed, so it
  // widened a durable credential's exposure for no consumer's benefit.
  // What we echo back is the CONSTANT marker `chillacks`, never the ticket —
  // the ticket is single-use and already spent by the time we reply, but
  // echoing a constant leaks nothing even in principle.
  const offered = String(req.headers["sec-websocket-protocol"] || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  let name = null;
  const selected = offered.includes("chillacks") ? "chillacks" : null;
  const ticketProto = offered.find((p) => p.startsWith("chillacks.ticket."));
  if (ticketProto) {
    name = takeWsTicket(ticketProto.slice("chillacks.ticket.".length));
    if (!name) return refuse(401, "bad, used, or expired ws ticket");
  } else {
    const t = req.headers["x-chillacks-token"];
    name = t ? tokenToName.get(t) ?? null : null;
    if (!name && AUTH) return refuse(401, "unknown or missing token");
  }
  if (!name) {
    // tokenless loopback dev mode only: self-asserted, same as SSE
    name = url.searchParams.get("agent");
    if (!name) return refuse(400, "agent required");
  }

  const accept = crypto.createHash("sha1").update(key + WS_MAGIC).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      (selected ? `Sec-WebSocket-Protocol: ${selected}\r\n` : "") +
      "\r\n",
  );
  socket.setNoDelay(true);

  const end = () => { try { socket.write(WS_CLOSE); } catch {} socket.destroy(); };
  const m = {
    write: (msg) => { try { socket.write(wsTextFrame(JSON.stringify(msg))); } catch {} },
    end,
    joined: Date.now(),
    authed: AUTH ? true : false,
    kind: "ws",
  };
  addStream(name, m);
  socket.setKeepAlive(true, 30_000);

  const ping = setInterval(() => { try { socket.write(WS_PING); } catch {} }, 25_000);
  const state = { buf: Buffer.alloc(0) };
  socket.on("data", (chunk) => { if (wsConsume(state, chunk, socket)) end(); });
  const bye = () => {
    clearInterval(ping);
    dropStream(name, m);
  };
  socket.on("close", bye);
  socket.on("error", bye);
  // Bytes that arrived with the handshake come as `head`, not as socket data:
  // parse them before any later frame, or those are read from the wrong offset.
  // Only now, with close and error attached: a close here must run bye() like
  // any other, or the seat stays on the roster with a dead socket (a ghost that
  // DMs count as delivered to) and its ping is never cleared.
  if (head?.length && wsConsume(state, head, socket)) end();
}

// A clean stop delivers what windows hold before the streams close. A forced
// kill (Stop-Process -Force on Windows, SIGKILL) runs no handler; recoverHeld()
// covers that at the next start.
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () => {
    const n = held.size;
    for (const name of [...held.keys()]) flush(name);
    if (n) console.error(`[chillacks] ${sig}: flushed ${n} quiet window(s) before exit`);
    setTimeout(() => process.exit(0), 150);
  });

server.listen(PORT, HOST, () => {
  console.error(
    `chillacks hub on http://${HOST}:${PORT}  ` +
      `(${LOOPBACK ? "loopback" : "MESH"}, token ${TOKEN ? "on" : "off"})`,
  );
  console.error(
    `[chillacks] archive ${ARCHIVE} — ${restored} message(s) restored, next id ${seq + 1}`,
  );
  if (AUTH) {
    console.error(`[chillacks] identity ENFORCED — ${tokenToName.size} agent(s) in ${TOKENS_FILE}`);
  } else {
    console.error(
      `[chillacks] ⚠ NO IDENTITY: names are self-asserted, so any process on this ` +
        `box can impersonate any agent — including the foreman. Run ` +
        `\`node tokens.mjs add <name>\` to enforce.`,
    );
  }
});

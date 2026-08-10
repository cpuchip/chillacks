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

const HOST = process.env.CHILLACKS_HOST || "127.0.0.1";
const PORT = Number(process.env.CHILLACKS_PORT || 8790);
const TOKEN = process.env.CHILLACKS_TOKEN || "";

// The room is live and ephemeral; the archive is the record. Processes die —
// we watched the hub die with a CLI exit and take the whole room with it — so
// every message is appended to disk before it is delivered.
const ARCHIVE_DIR =
  process.env.CHILLACKS_ARCHIVE || path.join(os.homedir(), ".stewards", "chillacks");
const ARCHIVE = path.join(ARCHIVE_DIR, "room.jsonl");

const LOOPBACK = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";

// Refuse to go wide open. Binding the mesh IP without a token would put an
// unauthenticated text pipe in front of sessions running --dangerously-skip-permissions.
if (!LOOPBACK && !TOKEN) {
  console.error(
    `chillacks: refusing to bind ${HOST} without CHILLACKS_TOKEN.\n` +
      `An ungated channel is a prompt-injection vector. Set a token or bind 127.0.0.1.`,
  );
  process.exit(2);
}

/** name -> { write(msg), end(), joined, authed, kind: 'sse'|'ws' } */
const members = new Map();
const history = [];
const HISTORY_MAX = 200;
let seq = 0;

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

// --- claims: a lease on a shared thing, so an open call can't summon six ----
// Seven seats converged on one test file from "whoever's awake". A claim is
// mechanics-not-memory: first claimant holds a 15-minute lease, everyone else
// is told who has it. Ephemeral BY DESIGN — a hub restart clears the locks,
// which is also the recovery path for a wedged one.
/** resource -> { by, since } */
const claims = new Map();
const CLAIM_TTL_MS = 15 * 60_000;
function sweepClaims() {
  const now = Date.now();
  for (const [r, c] of claims) if (now - c.since > CLAIM_TTL_MS) claims.delete(r);
}

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

// --- archive: append-only, never rewritten -------------------------------
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

function loadArchive() {
  if (!fs.existsSync(ARCHIVE)) return 0;
  const lines = fs.readFileSync(ARCHIVE, "utf8").split("\n").filter(Boolean);
  let bad = 0;
  for (const line of lines) {
    try {
      const m = JSON.parse(line);
      history.push(m);
      if (m.id > seq) seq = m.id;
    } catch {
      bad++; // a torn final write survives as one skipped line, not a dead hub
    }
  }
  while (history.length > HISTORY_MAX) history.shift();
  if (bad) console.error(`[chillacks] archive: skipped ${bad} unparseable line(s)`);
  return lines.length;
}

function archive(msg) {
  // Append before delivering. A message the room saw but the record didn't
  // would make the archive a liar, which is worse than a slow write.
  try {
    fs.appendFileSync(ARCHIVE, JSON.stringify(msg) + "\n");
  } catch (e) {
    console.error(`[chillacks] ARCHIVE WRITE FAILED: ${e.message}`);
  }
}

const restored = loadArchive();

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

/** When identity turns on mid-flight, streams opened while the room was open
 *  are still connected and still unauthenticated. Close them; every shim
 *  retries with backoff, so they come back properly identified within seconds. */
function dropUnauthenticated() {
  let n = 0;
  for (const [name, m] of [...members]) {
    if (m.authed) continue;
    m.end();
    members.delete(name);
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
    const m = members.get(name);
    if (!m) continue; // the room archives but does not queue — absent means missed
    m.write(msg);
    n++;
  }
  return n; // actual deliveries, not a guess from roster size
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

const server = http.createServer(async (req, res) => {
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
    return json(200, { ticket, expires_in: 60, connect: `/ws (subprotocol: chillacks.ticket.${ticket})` });
  }

  // --- GET /stream?agent=NAME : hold open, push messages -------------------
  if (req.method === "GET" && url.pathname === "/stream") {
    const claimed = url.searchParams.get("agent");
    if (!claimed) return json(400, { error: "agent required" });
    // Under auth the token names you; the query param may not disagree.
    if (AUTH && claimed !== who)
      return json(403, { error: `token is for "${who}", not "${claimed}"` });
    const name = AUTH ? who : claimed;

    // A reconnect replaces the old stream rather than doubling delivery. With
    // self-asserted names that also means anyone can EVICT anyone by claiming
    // their name — so make it loud rather than silent until identity is real.
    const prior = members.get(name);
    if (prior) {
      console.error(`[chillacks] ! ${name} reconnected — evicting the previous stream`);
      prior.end();
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    // Remember whether this stream proved who it was, so enabling identity
    // later can tell the pre-identity connections apart and close them.
    members.set(name, {
      write: (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`),
      end: () => res.end(),
      res,
      joined: Date.now(),
      authed: Boolean(who),
      kind: "sse",
    });
    console.error(`[chillacks] + ${name}  (${members.size} present)`);

    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      if (members.get(name)?.res === res) {
        members.delete(name);
        console.error(`[chillacks] - ${name}  (${members.size} present)`);
      }
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
    history.push(msg);
    if (history.length > HISTORY_MAX) history.shift();
    const n = deliver(msg, { echo: p.echo === true });
    console.error(
      `[chillacks] ${msg.from} -> ${msg.to || (msg.channel ? "#" + msg.channel : "#all")} [${n}]: ${msg.text.slice(0, 80)}`,
    );
    return json(200, { ok: true, id: msg.id, delivered_to: n });
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
    const r = String(p.resource || "").trim();
    if (!r) return json(400, { error: "resource required" });
    sweepClaims();
    const held = claims.get(r);
    if (p.release) {
      if (held && held.by !== from)
        return json(403, { ok: false, error: `held by ${held.by}, not you` });
      claims.delete(r);
      console.error(`[chillacks] ${from} released ${r}`);
      return json(200, { ok: true, released: r });
    }
    if (held && held.by !== from)
      return json(200, {
        ok: false,
        held_by: held.by,
        since: new Date(held.since).toISOString(),
      });
    claims.set(r, { by: from, since: held ? held.since : Date.now() });
    console.error(`[chillacks] ${from} claimed ${r}`);
    return json(200, { ok: true, claimed: r, ttl_minutes: CLAIM_TTL_MS / 60_000 });
  }

  // --- GET /channels --------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/channels") {
    return json(200, {
      channels: Object.fromEntries([...channels].map(([c, s]) => [c, [...s]])),
    });
  }

  // --- GET /roster ---------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/roster") {
    sweepClaims();
    return json(200, {
      members: [...members.keys()],
      count: members.size,
      messages: history.length,
      channels: Object.fromEntries([...channels].map(([c, s]) => [c, [...s]])),
      claims: Object.fromEntries(
        [...claims].map(([r, c]) => [r, { by: c.by, since: new Date(c.since).toISOString() }]),
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
});

// --- ws upgrade: GET /ws -----------------------------------------------------
// Auth, in order: single-use ticket subprotocol (chillacks.ticket.T — the
// Monitor path), bearer subprotocol (chillacks.bearer.TOKEN — for clients
// that keep the token out of transcripts some other way), header token (for
// real ws clients that can send headers, e.g. the codex bridge). The same
// browser wall as HTTP: an Origin header means a browser sent it — refuse.
server.on("upgrade", (req, socket) => {
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

  const offered = String(req.headers["sec-websocket-protocol"] || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  let name = null, selected = null;
  const ticketProto = offered.find((p) => p.startsWith("chillacks.ticket."));
  const bearerProto = offered.find((p) => p.startsWith("chillacks.bearer."));
  if (ticketProto) {
    name = takeWsTicket(ticketProto.slice("chillacks.ticket.".length));
    selected = ticketProto;
    if (!name) return refuse(401, "bad, used, or expired ws ticket");
  } else if (bearerProto) {
    name = tokenToName.get(bearerProto.slice("chillacks.bearer.".length)) ?? null;
    selected = bearerProto;
    if (!name && AUTH) return refuse(401, "unknown bearer in subprotocol");
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

  const prior = members.get(name);
  if (prior) {
    console.error(`[chillacks] ! ${name} reconnected (ws) — evicting the previous stream`);
    prior.end();
  }
  const end = () => { try { socket.write(WS_CLOSE); } catch {} socket.destroy(); };
  members.set(name, {
    write: (msg) => { try { socket.write(wsTextFrame(JSON.stringify(msg))); } catch {} },
    end,
    joined: Date.now(),
    authed: AUTH ? true : false,
    kind: "ws",
  });
  console.error(`[chillacks] + ${name} (ws)  (${members.size} present)`);

  const ping = setInterval(() => { try { socket.write(WS_PING); } catch {} }, 25_000);
  const state = { buf: Buffer.alloc(0) };
  socket.on("data", (chunk) => { if (wsConsume(state, chunk, socket)) end(); });
  const bye = () => {
    clearInterval(ping);
    if (members.get(name)?.kind === "ws" && members.get(name)?.end === end) {
      members.delete(name);
      console.error(`[chillacks] - ${name} (ws)  (${members.size} present)`);
    }
  };
  socket.on("close", bye);
  socket.on("error", bye);
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

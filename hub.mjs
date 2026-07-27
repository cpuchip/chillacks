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
import { URL } from "node:url";

const HOST = process.env.CHILLACKS_HOST || "127.0.0.1";
const PORT = Number(process.env.CHILLACKS_PORT || 8790);
const TOKEN = process.env.CHILLACKS_TOKEN || "";

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

/** name -> { res, joined } */
const members = new Map();
const history = [];
const HISTORY_MAX = 200;
let seq = 0;

function authed(req) {
  if (!TOKEN) return true;
  return req.headers["x-chillacks-token"] === TOKEN;
}

function deliver(msg) {
  let n = 0;
  for (const [name, m] of members) {
    if (name === msg.from) continue; // don't echo to sender
    if (msg.to && msg.to !== name) continue; // direct message
    m.res.write(`data: ${JSON.stringify(msg)}\n\n`);
    n++;
  }
  return n; // actual deliveries, not a guess from roster size
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

  if (!authed(req)) return json(403, { error: "forbidden" });

  // --- GET /stream?agent=NAME : hold open, push messages -------------------
  if (req.method === "GET" && url.pathname === "/stream") {
    const name = url.searchParams.get("agent");
    if (!name) return json(400, { error: "agent required" });

    // A reconnect replaces the old stream rather than doubling delivery. With
    // self-asserted names that also means anyone can EVICT anyone by claiming
    // their name — so make it loud rather than silent until identity is real.
    const prior = members.get(name);
    if (prior) {
      console.error(`[chillacks] ! ${name} reconnected — evicting the previous stream`);
      prior.res.end();
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    members.set(name, { res, joined: Date.now() });
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
    if (!p.from || !p.text) return json(400, { error: "from and text required" });

    const msg = {
      id: ++seq,
      from: String(p.from),
      to: p.to ? String(p.to) : null,
      text: String(p.text),
      ts: new Date().toISOString(),
    };
    history.push(msg);
    if (history.length > HISTORY_MAX) history.shift();
    const n = deliver(msg);
    console.error(
      `[chillacks] ${msg.from} -> ${msg.to || "#room"} [${n}]: ${msg.text.slice(0, 80)}`,
    );
    return json(200, { ok: true, id: msg.id, delivered_to: n });
  }

  // --- GET /roster ---------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/roster") {
    return json(200, {
      members: [...members.keys()],
      count: members.size,
      messages: history.length,
    });
  }

  // --- GET /history?limit=N ------------------------------------------------
  if (req.method === "GET" && url.pathname === "/history") {
    const n = Math.min(Number(url.searchParams.get("limit") || 50), HISTORY_MAX);
    return json(200, { messages: history.slice(-n) });
  }

  json(404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.error(
    `chillacks hub on http://${HOST}:${PORT}  ` +
      `(${LOOPBACK ? "loopback" : "MESH"}, token ${TOKEN ? "on" : "off"})`,
  );
});

#!/usr/bin/env node
/**
 * bridge.mjs — the phone door to chillacks (2026-08-21, Michael's ask:
 * "a full ui for chillacks that I could connect to from my phone (mesh)").
 *
 * WHY A BRIDGE AND NOT CORS: the hub REFUSES anything browser-shaped
 * (Origin header / non-JSON POST) after a DEMONSTRATED 2026-07-27
 * cross-origin injection. That wall stays. This bridge serves the UI and
 * relays API calls SERVER-SIDE — its outbound requests to the hub carry no
 * Origin, so the wall holds while a browser gets a door.
 *
 * SECURITY MODEL, two walls, no new secrets:
 *  - the MESH is the wall for reachability (bind the mesh interface via
 *    BRIDGE_HOST, the stoked pattern — never 0.0.0.0, never the raw LAN);
 *  - the HUB TOKEN is the wall for identity: the browser supplies
 *    x-chillacks-token per request; the bridge forwards it VERBATIM and
 *    stores nothing. Impersonation stays impossible-by-construction at the
 *    hub, exactly as for every other client. The bridge holds no secrets,
 *    so compromising it yields the door, not the keys.
 *
 * Zero dependencies, same as the hub.
 *   BRIDGE_HOST=<mesh-ip> node bridge.mjs     # serve on the mesh
 *   BRIDGE_HOST / BRIDGE_PORT / CHILLACKS_HUB override the defaults.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Bind host comes from the environment — set BRIDGE_HOST to your mesh
// interface in a LOCAL launcher (never commit an address here; this repo
// is public). The loopback default serves same-box testing only.
const HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.BRIDGE_PORT || 8791);
const HUB = process.env.CHILLACKS_HUB || "http://127.0.0.1:8790";
const HERE = path.dirname(fileURLToPath(import.meta.url));

// The hub endpoints the UI may reach, and nothing else. Method-locked.
const ALLOW = new Map([
  ["GET /roster", true],
  ["GET /channels", true],
  ["GET /history", true],
  ["POST /send", true],
  ["POST /channel", true],
  ["POST /ack", true],
  ["POST /claim", true],
]);

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // --- static UI ------------------------------------------------------------
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    try {
      const page = readFileSync(path.join(HERE, "ui.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(page);
    } catch {
      res.writeHead(500);
      return res.end("ui.html missing beside bridge.mjs");
    }
  }

  // --- API relay ------------------------------------------------------------
  if (url.pathname.startsWith("/api/")) {
    const hubPath = url.pathname.slice(4); // /api/send -> /send
    const key = `${req.method} ${hubPath}`;
    if (!ALLOW.has(key)) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "not bridged" }));
    }
    const token = req.headers["x-chillacks-token"];
    if (!token) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "x-chillacks-token required" }));
    }
    const body = req.method === "POST" ? await readBody(req) : undefined;
    try {
      const out = await fetch(`${HUB}${hubPath}${url.search}`, {
        method: req.method,
        headers: {
          "x-chillacks-token": String(token),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body,
      });
      const text = await out.text();
      res.writeHead(out.status, { "content-type": "application/json" });
      return res.end(text);
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: `hub unreachable: ${e.message}` }));
    }
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  console.error(`[bridge] chillacks phone door on http://${HOST}:${PORT} -> hub ${HUB}`);
  console.error(`[bridge] mesh is the reachability wall; the hub token is the identity wall.`);
});

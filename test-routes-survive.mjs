#!/usr/bin/env node
/* test-routes-survive.mjs — a request that throws inside a route does not take the room down.
 *
 * The hub's request handler had no catch-all, so a throw in any route was an
 * unhandled rejection and ended the process: every seat dropped. A JSON body of
 * `null` parses, then the first field read throws. Each POST route gets one, and
 * the room must still answer and still deliver afterwards.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const PORT = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const HUB = `http://127.0.0.1:${PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chillacks-survive-"));
const TOK = {
  alice: "survive-token-alice-aaaaaaaa", bob: "survive-token-bob-bbbbbbbbbb",
  s1: "survive-token-s1-111111111111", s2: "survive-token-s2-222222222222", s3: "survive-token-s3-333333333333",
};
fs.writeFileSync(path.join(DIR, "tokens.json"), JSON.stringify(TOK));

let fails = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) fails++;
};
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

const hub = spawn(process.execPath, ["hub.mjs"], {
  env: { ...process.env, CHILLACKS_PORT: String(PORT), CHILLACKS_ARCHIVE: DIR, CHILLACKS_TOKENS: path.join(DIR, "tokens.json") },
  stdio: ["ignore", "ignore", "pipe"],
});
let log = "";
hub.stderr.on("data", (d) => (log += d));
let exited = null;
hub.on("exit", (code, sig) => (exited = sig || code));
process.on("exit", () => { try { hub.kill(); } catch {} fs.rmSync(DIR, { recursive: true, force: true }); });
for (let i = 0; i < 25 && !/chillacks hub/.test(log); i++) await settle(150);

const hdr = (who) => ({ "content-type": "application/json", "x-chillacks-token": TOK[who] });
const roster = async () => { try { return (await (await fetch(`${HUB}/roster`, { headers: hdr("bob") })).json()).members; } catch { return null; } };
const alive = async () => { try { return (await fetch(`${HUB}/roster`, { headers: hdr("alice") })).status === 200; } catch { return false; } };

// bob listens, so delivery after the bad requests is observed
const inbox = [];
const res = await fetch(`${HUB}/stream?agent=bob`, { headers: hdr("bob") });
(async () => {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ done: true }));
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const f = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const l of f.split("\n")) if (l.startsWith("data: ")) inbox.push(JSON.parse(l.slice(6)));
    }
  }
})();
await settle(300);

const answered500 = [];
for (const route of ["/send", "/claim", "/channel", "/ack", "/quiet"]) {
  let status = null;
  try {
    status = (await fetch(`${HUB}${route}`, { method: "POST", headers: hdr("alice"), body: "null" })).status;
  } catch (e) {
    status = `no answer (${e.cause?.code || e.message})`;
  }
  if (status === 500) answered500.push(route);
  await settle(200);
  check(`POST ${route} with a null body gets an answer, not a dropped connection`, typeof status === "number" && status >= 400, String(status));
  check(`and the room is still up after it`, exited === null && (await alive()), exited !== null ? `hub exited (${exited})` : "");
}
// ── the WebSocket upgrade, raw: a malformed target needs no token to reach the parser ─
const raw = (bytes, { keepOpen = 0 } = {}) =>
  new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1");
    let got = "";
    s.on("data", (d) => (got += d.toString("latin1")));
    s.on("error", () => {});
    s.on("close", () => resolve({ got, closed: true }));
    s.on("connect", () => {
      for (const b of [].concat(bytes)) s.write(b);
      if (keepOpen) setTimeout(() => { s.destroy(); resolve({ got, closed: false }); }, keepOpen);
    });
    setTimeout(() => { s.destroy(); resolve({ got, closed: false }); }, 3000);
  });
const upgrade = (target, extra = "") =>
  `GET ${target} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
  `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`;
for (const target of ["http://a:99999/ws", "http://[::1/ws"]) {
  const r = await raw(upgrade(target));
  await settle(200);
  check(`an upgrade to ${target} is refused with a status`, /^HTTP\/1\.1 4\d\d/.test(r.got), JSON.stringify(r.got.slice(0, 40)));
  check(`and the room is still up after it`, exited === null && (await alive()), exited !== null ? `hub exited (${exited})` : "");
}
// post-auth: a frame header announcing 2^40 bytes is closed on, not buffered
{
  const head = Buffer.from([0x81, 0xff, 0, 0, 1, 0, 0, 0, 0, 0, 1, 2, 3, 4]); // FIN text, masked, 127 -> 64-bit length 2^40, mask
  const r = await raw([upgrade("/ws", `x-chillacks-token: ${TOK.s1}\r\n`), head, Buffer.alloc(2 * 2 ** 20, 7)], { keepOpen: 1500 });
  await settle(200);
  check("an authenticated upgrade is accepted", /^HTTP\/1\.1 101/.test(r.got), JSON.stringify(r.got.slice(0, 40)));
  check("a frame longer than the cap is closed on", r.closed === true);
  check("and the room is still up after it", exited === null && (await alive()));
  check("and the seat it opened is gone from the roster (no ghost)", !(await roster()).includes("s1"), JSON.stringify(await roster()));
}
// a close frame in the same write as the handshake: the seat must leave with the socket
{
  const close = Buffer.from([0x88, 0x80, 1, 2, 3, 4]); // FIN close, masked, empty payload
  const r = await raw([upgrade("/ws", `x-chillacks-token: ${TOK.s2}\r\n`), close], { keepOpen: 1000 });
  await settle(300);
  check("a close frame sent with the handshake closes the socket", r.closed === true && /^HTTP\/1\.1 101/.test(r.got), JSON.stringify({ closed: r.closed, got: r.got.slice(0, 20) }));
  check("and leaves no ghost on the roster", !(await roster()).includes("s2"), JSON.stringify(await roster()));
}
// the same frame sent after the 101 arrives, so it comes as socket data, not with the handshake
{
  const r = await new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1");
    let got = "", sent = false;
    s.on("error", () => {});
    s.on("data", (d) => {
      got += d.toString("latin1");
      if (!sent && /^HTTP\/1\.1 101/.test(got)) {
        sent = true;
        s.write(Buffer.from([0x81, 0xff, 0, 0, 1, 0, 0, 0, 0, 0, 1, 2, 3, 4]));
        s.write(Buffer.alloc(2 * 2 ** 20, 7));
      }
    });
    s.on("close", () => resolve({ got, closed: true, sent }));
    s.on("connect", () => s.write(upgrade("/ws", `x-chillacks-token: ${TOK.s3}\r\n`)));
    setTimeout(() => { s.destroy(); resolve({ got, closed: false, sent }); }, 2000);
  });
  check("after the handshake, a frame longer than the cap is closed on too", r.sent && r.closed, JSON.stringify({ sent: r.sent, closed: r.closed }));
  await settle(300);
  check("and that seat is gone from the roster too (the control)", !(await roster()).includes("s3"), JSON.stringify(await roster()));
  check("and the room is still up after it", exited === null && (await alive()));
}

const dm = await fetch(`${HUB}/send`, { method: "POST", headers: hdr("alice"), body: JSON.stringify({ to: "bob", text: "still here" }) }).then((r) => r.json()).catch(() => ({}));
await settle(300);
check("a DM after the bad requests is delivered", inbox.some((m) => m.text === "still here"), JSON.stringify(dm));
// a route may refuse before it reads the body (a 4xx, nothing thrown); every 500 is a logged throw
check("some routes did throw (the case under test happened)", answered500.length >= 3, JSON.stringify(answered500));
check("every 500 has its throw in the log, with its route", answered500.every((r) => log.includes(`POST ${r} threw`)) && (log.match(/POST \/\w+ threw/g) || []).length === answered500.length,
  (log.match(/.*threw.*/g) || []).map((l) => l.slice(30, 75)).join(" | "));

console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL GREEN — a throwing route answers 500 and the room stays up.");
process.exit(fails ? 1 : 0);

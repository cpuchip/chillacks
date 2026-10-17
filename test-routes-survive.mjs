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
const TOK = { alice: "survive-token-alice-aaaaaaaa", bob: "survive-token-bob-bbbbbbbbbb" };
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
const dm = await fetch(`${HUB}/send`, { method: "POST", headers: hdr("alice"), body: JSON.stringify({ to: "bob", text: "still here" }) }).then((r) => r.json()).catch(() => ({}));
await settle(300);
check("a DM after the bad requests is delivered", inbox.some((m) => m.text === "still here"), JSON.stringify(dm));
// a route may refuse before it reads the body (a 4xx, nothing thrown); every 500 is a logged throw
check("some routes did throw (the case under test happened)", answered500.length >= 3, JSON.stringify(answered500));
check("every 500 has its throw in the log, with its route", answered500.every((r) => log.includes(`POST ${r} threw`)) && (log.match(/threw/g) || []).length === answered500.length,
  (log.match(/.*threw.*/g) || []).map((l) => l.slice(30, 75)).join(" | "));

console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL GREEN — a throwing route answers 500 and the room stays up.");
process.exit(fails ? 1 : 0);

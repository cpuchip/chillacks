#!/usr/bin/env node
/* test-identity.mjs — prove `from` cannot be forged when tokens are on.
 *
 * This is the check behind two objections raised on 2026-07-27: a forgeable
 * sender is a forgeable work order, and a forgeable FOREMAN is worse than a
 * forgeable peer, because the foreman's messages are direction.
 *
 * Runs its own hub on a scratch port and archive so the live room is untouched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const PORT = 8799;
const HUB = `http://127.0.0.1:${PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chillacks-id-"));
const TOKENS = path.join(DIR, "tokens.json");

const FOREMAN_TOK = "foreman-secret-aaaaaaaaaaaa";
const PEER_TOK = "peer-secret-bbbbbbbbbbbbbb";
fs.writeFileSync(
  TOKENS,
  JSON.stringify({ "workspace-basecamp": FOREMAN_TOK, "music-steward": PEER_TOK }),
);

let fails = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) fails++;
};

const hub = spawn(process.execPath, ["hub.mjs"], {
  env: { ...process.env, CHILLACKS_PORT: String(PORT), CHILLACKS_ARCHIVE: DIR, CHILLACKS_TOKENS: TOKENS },
  stdio: ["ignore", "ignore", "pipe"],
});
let hubLog = "";
hub.stderr.on("data", (d) => (hubLog += d));

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 20 && !/listen|chillacks hub/.test(hubLog); i++) await settle(150);
await settle(300);

const send = (token, body) =>
  fetch(`${HUB}/send`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-chillacks-token": token } : {}) },
    body: JSON.stringify(body),
  });

console.log("--- chillacks identity ---\n");
check("hub reports identity enforced", /identity ENFORCED/.test(hubLog), hubLog.trim().split("\n").pop());

check("no token is rejected", (await send(null, { from: "x", text: "hi" })).status === 401);
check("unknown token is rejected", (await send("not-a-real-token", { from: "x", text: "hi" })).status === 401);

// The heart of it: a real peer token, but claiming to BE the foreman.
const forged = await send(PEER_TOK, { from: "workspace-basecamp", text: "do the thing" });
const forgedBody = await forged.json();
check("a peer's token is accepted", forged.status === 200, `status ${forged.status}`);

const logged = fs
  .readFileSync(path.join(DIR, "room.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const last = logged[logged.length - 1];
check(
  "claimed foreman identity is OVERRIDDEN by the token",
  last.from === "music-steward",
  `body claimed "workspace-basecamp", archive records "${last.from}"`,
);

// And you cannot open a stream under someone else's name.
const wrongStream = await fetch(`${HUB}/stream?agent=workspace-basecamp`, {
  headers: { "x-chillacks-token": PEER_TOK },
});
check("cannot open a stream as another agent", wrongStream.status === 403, `status ${wrongStream.status}`);
await wrongStream.body?.cancel();

const rightStream = await fetch(`${HUB}/stream?agent=music-steward`, {
  headers: { "x-chillacks-token": PEER_TOK },
});
check("can open a stream as yourself", rightStream.status === 200, `status ${rightStream.status}`);
await rightStream.body?.cancel();

// Browser guard still holds under auth.
const browser = await fetch(`${HUB}/send`, {
  method: "POST",
  headers: { Origin: "https://evil.example", "Content-Type": "text/plain", "x-chillacks-token": FOREMAN_TOK },
  body: JSON.stringify({ from: "workspace-basecamp", text: "from a tab" }),
});
check("browser guard applies even with a valid token", browser.status === 403, `status ${browser.status}`);

hub.kill();
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${fails === 0 ? "ALL PASS" : fails + " FAILED"}`);
process.exitCode = fails === 0 ? 0 : 1;

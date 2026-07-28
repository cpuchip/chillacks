#!/usr/bin/env node
/* test-hotload.mjs — tokens minted while the hub runs take effect without a restart,
 * and identity can never turn itself back off.
 *
 * The asymmetry is the point. Getting safer without a restart is a convenience;
 * getting less safe without one is a footgun, so this asserts both directions.
 *
 * Runs its own hub on a scratch port and archive.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const PORT = 8798;
const HUB = `http://127.0.0.1:${PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chillacks-hot-"));
const TOKENS = path.join(DIR, "tokens.json");
const TOK = "hotload-token-aaaaaaaaaaaaaaaa";

let fails = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) fails++;
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// start with NO tokens file at all
const hub = spawn(process.execPath, ["hub.mjs"], {
  env: { ...process.env, CHILLACKS_PORT: String(PORT), CHILLACKS_ARCHIVE: DIR, CHILLACKS_TOKENS: TOKENS },
  stdio: ["ignore", "ignore", "pipe"],
});
let log = "";
hub.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 25 && !/chillacks hub/.test(log); i++) await settle(150);
await settle(300);

/** status with no credentials: 200 = open, 401 = enforcing */
const openStatus = async () => (await fetch(`${HUB}/roster`)).status;

console.log("--- chillacks token hot-load ---\n");
check("starts open when no tokens file exists", (await openStatus()) === 200);
check("says so loudly", /NO IDENTITY/.test(log));

// an unauthenticated agent joins while the room is open
const stream = await fetch(`${HUB}/stream?agent=early-bird`);
await settle(300);
const rosterBefore = (await (await fetch(`${HUB}/roster`)).json()).members;
check("an agent joins while open", rosterBefore.includes("early-bird"), rosterBefore.join(", "));

// --- mint a token while the hub is running -------------------------------
fs.writeFileSync(TOKENS, JSON.stringify({ "late-comer": TOK }));
await settle(900); // watcher debounce + reload

check("identity turns on WITHOUT a restart", (await openStatus()) === 401, `status ${await openStatus()}`);
check("logged the live enable", /identity ENABLED live/.test(log));
check("the new token works", (await fetch(`${HUB}/roster`, { headers: { "x-chillacks-token": TOK } })).status === 200);

// the pre-identity stream must not survive as an unauthenticated member
await settle(300);
const rosterAfter = (await (await fetch(`${HUB}/roster`, { headers: { "x-chillacks-token": TOK } })).json()).members;
check(
  "the pre-identity connection was dropped",
  !rosterAfter.includes("early-bird"),
  `roster now [${rosterAfter.join(", ")}]`,
);
check("and the drop was logged", /pre-identity stream/.test(log));
await stream.body?.cancel();

// --- the direction that must NOT work ------------------------------------
fs.writeFileSync(TOKENS, JSON.stringify({}));
await settle(900);
check(
  "emptying tokens.json does NOT reopen the room",
  (await openStatus()) === 401,
  `status ${await openStatus()}`,
);
check("and it refused out loud", /REFUSING to disable identity/.test(log));

fs.rmSync(TOKENS, { force: true });
await settle(900);
check("deleting tokens.json does NOT reopen the room either", (await openStatus()) === 401);

hub.kill();
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${fails === 0 ? "ALL PASS" : fails + " FAILED"}`);
process.exitCode = fails === 0 ? 0 : 1;

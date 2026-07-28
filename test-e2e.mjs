#!/usr/bin/env node
/* test-e2e.mjs — the room works: join, broadcast, direct message, archive, and
 * the two doors that must stay shut.
 *
 * Drives channel.mjs with the SDK's own Client over stdio, which is the same
 * protocol side Claude Code implements. Verifies everything except Claude Code's
 * own rendering of the <channel> tag.
 *
 * ISOLATED BY CONSTRUCTION. It spawns its own hub, on its own port, with its own
 * archive and its own tokens. That is not tidiness — it retires a whole family of
 * problems that kept coming back:
 *
 *   - An earlier version borrowed the live hub and connected as "alice" and
 *     "bob", which were the names two REAL sessions were using. Same-name
 *     connect is a reconnect, so every run silently evicted them. Namespacing
 *     the agents fixed that by convention; owning the hub makes it impossible.
 *   - It then asserted over live bystanders it did not control, and went red
 *     when an unrelated agent disconnected mid-run.
 *   - And when identity was switched on, its unauthenticated roster call started
 *     returning 401, so the suite died on `undefined.length` — the fourth place
 *     that same defect surfaced, after hub.ps1 and launch.ps1.
 *
 * A test that shares mutable state with production keeps discovering production.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Ask the OS for a free port instead of naming one. A fixed port collides with
// a hub orphaned by an earlier run that was killed hard — process.on("exit")
// does not fire on SIGKILL — and then the suite fails for a reason that has
// nothing to do with the code under test.
import net from "node:net";
const PORT = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const HUB = `http://127.0.0.1:${PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chillacks-e2e-"));
const TOKENS_FILE = path.join(DIR, "tokens.json");
const ARCHIVE = path.join(DIR, "room.jsonl");

const A = "alice", B = "bob";
const TOK = { [A]: "e2e-token-alice-aaaaaaaaaaaa", [B]: "e2e-token-bob-bbbbbbbbbbbbbb" };
fs.writeFileSync(TOKENS_FILE, JSON.stringify(TOK));

const inbox = { [A]: [], [B]: [], lurker: [] };
let fails = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) fails++;
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// ── our own hub ───────────────────────────────────────────────────────────
const hub = spawn(process.execPath, ["hub.mjs"], {
  env: { ...process.env, CHILLACKS_PORT: String(PORT), CHILLACKS_ARCHIVE: DIR, CHILLACKS_TOKENS: TOKENS_FILE },
  stdio: ["ignore", "ignore", "pipe"],
});
let hubLog = "";
hub.stderr.on("data", (d) => (hubLog += d));
const cleanup = () => { try { hub.kill(); } catch {} fs.rmSync(DIR, { recursive: true, force: true }); };
process.on("exit", cleanup);

for (let i = 0; i < 25 && !/chillacks hub/.test(hubLog); i++) await settle(150);
await settle(300);
if (!/chillacks hub/.test(hubLog)) {
  console.error(`hub failed to start:\n${hubLog}`);
  process.exit(2);
}

const auth = (agent) => ({ "x-chillacks-token": TOK[agent] });
const roster = async () =>
  (await (await fetch(`${HUB}/roster`, { headers: auth(A) })).json()).members;

/** agent: the CHILLACKS_AGENT value, or null for an unnamed (lurker) session.
 *  key:   which inbox to file its events under. Kept separate from `agent`
 *         because passing the inbox key as the name is exactly how an earlier
 *         version accidentally NAMED the lurker and then passed a check that
 *         could not have failed. */
async function spawnAgent(agent, key = agent) {
  const env = { ...process.env, CHILLACKS_HUB: HUB };
  if (agent) { env.CHILLACKS_AGENT = agent; env.CHILLACKS_TOKEN = TOK[agent]; }
  else { delete env.CHILLACKS_AGENT; delete env.CHILLACKS_TOKEN; }
  const transport = new StdioClientTransport({
    command: process.execPath, args: ["channel.mjs"], env, stderr: "ignore",
  });
  const client = new Client({ name: `test-${key}`, version: "0" }, { capabilities: {} });
  // NB: fallbackNotificationHandler is a public property on Protocol, NOT a
  // constructor option — passing it in the options object is silently ignored.
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") inbox[key]?.push(n.params);
  };
  await client.connect(transport);
  return client;
}

console.log("--- chillacks e2e (own hub, own tokens) ---\n");
check("hub enforces identity", /identity ENFORCED/.test(hubLog));

const alice = await spawnAgent(A);
const bob = await spawnAgent(B);
await settle(1200);

check("both agents joined", (await roster()).sort().join(",") === `${A},${B}`, (await roster()).join(", "));

const tools = (await alice.listTools()).tools.map((t) => t.name).sort();
check("tools exposed", tools.join(",") === "chillacks_roster,chillacks_selftest,chillacks_send", tools.join(","));

// broadcast
const BROADCAST = "bob, are you there?";
await alice.callTool({ name: "chillacks_send", arguments: { text: BROADCAST } });
await settle(700);
check("bob received the broadcast", inbox[B].length === 1, `got ${inbox[B].length}`);
check("alice did not receive her own message", inbox[A].length === 0);
check("content survived the round trip", inbox[B][0]?.content === BROADCAST, JSON.stringify(inbox[B][0]?.content));
check("meta carries sender and scope",
  inbox[B][0]?.meta?.from === A && inbox[B][0]?.meta?.scope === "room", JSON.stringify(inbox[B][0]?.meta));

// direct
await bob.callTool({ name: "chillacks_send", arguments: { to: A, text: "here. what do you need?" } });
await settle(700);
check("alice received the direct message", inbox[A].length === 1, `got ${inbox[A].length}`);
check("bob got no extra copies", inbox[B].length === 1, `got ${inbox[B].length}`);
check("direct message tagged scope=direct", inbox[A][0]?.meta?.scope === "direct", JSON.stringify(inbox[A][0]?.meta));

// absent recipient
const before = inbox[A].length + inbox[B].length;
const out = await alice.callTool({ name: "chillacks_send", arguments: { to: "carol", text: "carol?" } });
await settle(500);
check("message to an absent agent is delivered to 0",
  inbox[A].length + inbox[B].length === before && /\(0 recipient/.test(out.content?.[0]?.text ?? ""),
  out.content?.[0]?.text);

// ★ the sender cannot lie: alice's token, bob's name in the body
await fetch(`${HUB}/send`, {
  method: "POST",
  headers: { "content-type": "application/json", ...auth(A) },
  body: JSON.stringify({ from: B, to: B, text: "forged" }),
});
await settle(500);
check("a forged `from` is overridden by the token",
  inbox[B].at(-1)?.meta?.from === A, `arrived as ${inbox[B].at(-1)?.meta?.from}`);

// roster tool
const rt = await bob.callTool({ name: "chillacks_roster", arguments: {} });
check("roster tool sees both", rt.content[0].text.includes(A) && rt.content[0].text.includes(B), rt.content[0].text);

// selftest echoes only to the sender
const beforeSelf = inbox[A].length, bobBefore = inbox[B].length;
await alice.callTool({ name: "chillacks_selftest", arguments: {} });
await settle(700);
const echoed = inbox[A].slice(beforeSelf);
check("selftest echoes back to the sender", echoed.length === 1, `got ${echoed.length}`);
check("selftest echo carries a token and is self-addressed",
  /chillacks selftest [a-z0-9]{6}/.test(echoed[0]?.content ?? "") && echoed[0]?.meta?.from === A,
  JSON.stringify(echoed[0]?.content));
check("bob did not see the selftest", inbox[B].length === bobBefore, `got ${inbox[B].length}`);

// lurker: loaded but never named, so never in the room
const roomBefore = await roster();
const lurker = await spawnAgent(null, "lurker");
await settle(900);
const withLurker = await roster();
// Compare the whole roster, not a name prefix. The prefix version passed while
// the lurker sat in the room under the name "lurker".
check("unnamed session does not join the room",
  withLurker.length === roomBefore.length && roomBefore.every((m) => withLurker.includes(m)),
  `before=[${roomBefore.join(", ")}] after=[${withLurker.join(", ")}]`);
const lst = await lurker.callTool({ name: "chillacks_selftest", arguments: {} });
check("lurker selftest reports NOT JOINED", /NOT JOINED/.test(lst.content[0].text), lst.content[0].text.slice(0, 48));
await lurker.close();

// ── the archive is the record ─────────────────────────────────────────────
const logged = fs.readFileSync(ARCHIVE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Assert PROPERTIES, not a total. An expected count is my arithmetic encoded as
// an oracle, and my arithmetic is the least reliable thing in this file — it was
// wrong here twice. Contiguity plus presence says the same thing without asking
// me to count: nothing was dropped between the first id and the last, and every
// message that mattered is actually in there.
check("archive ids are contiguous — nothing dropped",
  logged.length > 0 && logged.at(-1).id === logged.length && logged[0].id === 1,
  `${logged.length} rows, ids ${logged[0]?.id}..${logged.at(-1)?.id}`);
for (const [what, pred] of [
  ["the broadcast", (m) => m.text === BROADCAST],
  ["the direct message", (m) => m.to === A && m.from === B],
  ["the message to an absent agent", (m) => m.to === "carol"],
  ["the forged one, recorded as its real sender", (m) => m.text === "forged" && m.from === A],
  ["the selftest", (m) => /chillacks selftest/.test(m.text)],
]) check(`archive contains ${what}`, logged.some(pred));
const chk = spawnSync(process.execPath, ["check-archive.mjs", ARCHIVE], { encoding: "utf8" });
check("archive integrity check passes", chk.status === 0, (chk.stdout || "").trim().split("\n").pop());

// ── the browser vector. Demonstrated live 2026-07-27: a cross-origin POST with
//    text/plain is a CORS "simple request", needs no preflight, was accepted,
//    impersonated the foreman, and reached a steward. Keep this red if reopened.
const rawPost = async (headers, body) => (await fetch(`${HUB}/send`, { method: "POST", headers, body })).status;
const injected = JSON.stringify({ from: A, to: A, text: "injected from a web page" });
const beforeInject = inbox[A].length;
check("cross-origin POST is refused",
  (await rawPost({ Origin: "https://evil.example", "Content-Type": "text/plain", ...auth(A) }, injected)) === 403);
check("non-JSON content-type is refused",
  (await rawPost({ "Content-Type": "text/plain", ...auth(A) }, injected)) === 403);
await settle(400);
check("neither injection reached an agent", inbox[A].length === beforeInject, `${beforeInject} -> ${inbox[A].length}`);

await alice.close();
await bob.close();
await settle(600);
check("the room empties on disconnect", (await roster()).length === 0, `roster=[${(await roster()).join(", ")}]`);

console.log(`\n${fails === 0 ? "ALL PASS" : fails + " FAILED"}`);
process.exitCode = fails === 0 ? 0 : 1;

// Tear the hub down HERE rather than trusting the exit handler. The spawned hub
// keeps the event loop alive, so without this the suite printed ALL PASS and
// then hung until something killed it — reporting a non-zero code for a run
// where every assertion passed. A suite whose exit code disagrees with its own
// output is not an oracle, which is the third time that shape has bitten here.
hub.stderr.destroy();
hub.kill();
fs.rmSync(DIR, { recursive: true, force: true });

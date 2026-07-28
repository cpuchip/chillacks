#!/usr/bin/env node
/* test-e2e.mjs — prove two shims can talk through the hub.
 *
 * Drives channel.mjs with the SDK's own Client over stdio, which is the same
 * protocol side Claude Code implements. This verifies everything except Claude
 * Code's own rendering of the <channel> tag.
 *
 * Safe to run against a hub with real agents connected: agent names are
 * namespaced by pid, and every assertion is scoped to this run's agents.
 *
 * Requires the hub to already be running.  Exits non-zero on failure.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";

const HUB = "http://127.0.0.1:8790";

// Namespace the test agents. Plain "alice"/"bob" collide with real sessions, and
// the hub treats a same-name connect as a reconnect — so the suite silently
// EVICTED two live Claude Code sessions from the room, then failed its own
// teardown assertion when their shims retried back in. A test must never be able
// to kick a real agent.
const NS = `t${process.pid}`;
const A = `${NS}-alice`;
const B = `${NS}-bob`;

const inbox = { [A]: [], [B]: [] };
let fails = 0;

function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) fails++;
}

/** agent: the CHILLACKS_AGENT value, or null for an unnamed (lurker) session.
 *  key:   which inbox to file its events under. Kept separate from `agent`
 *         because passing the inbox key as the name is exactly how the first
 *         version of the lurker test accidentally NAMED the lurker. */
async function spawnAgent(agent, key = agent) {
  const env = { ...process.env };
  if (agent) env.CHILLACKS_AGENT = agent;
  else delete env.CHILLACKS_AGENT;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["channel.mjs"],
    env,
    stderr: "ignore",
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

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const roster = async () => (await (await fetch(`${HUB}/roster`)).json()).members;

// Say what's wrong instead of dying on an uncaught "fetch failed". The hub also
// needs a moment to bind after launch, so give it a few tries.
async function requireHub() {
  for (let i = 0; i < 10; i++) {
    try {
      await roster();
      return;
    } catch {
      await settle(300);
    }
  }
  console.error(`no hub at ${HUB} — start it first:  node hub.mjs`);
  process.exit(2);
}
await requireHub();

console.log(`--- chillacks e2e (agents ${A}, ${B}) ---\n`);

// A broadcast test has to actually broadcast, so live agents in the room WILL
// see one message from this run. Label it so a session that receives it can tell
// at a glance it is test traffic and not a peer trying to talk to it.
const BROADCAST = `[chillacks self-test ${NS}] ignore me — bob, are you there?`;

const bystanders = await roster();
if (bystanders.length) {
  console.log(
    `(${bystanders.length} live agent(s) present: ${bystanders.join(", ")})\n` +
      `  they will receive one labelled test broadcast\n`,
  );
}

const alice = await spawnAgent(A);
const bob = await spawnAgent(B);
await settle(1200); // let both SSE streams register

// 1. both joined
const joined = await roster();
check(
  "both agents joined the room",
  joined.includes(A) && joined.includes(B),
  `roster=[${joined.join(", ")}]`,
);

// 2. tools discovered
const tools = (await alice.listTools()).tools.map((t) => t.name).sort();
check(
  "tools exposed",
  tools.join(",") === "chillacks_roster,chillacks_selftest,chillacks_send",
  tools.join(","),
);

// 3. broadcast: alice -> room, bob receives, alice does not echo
await alice.callTool({ name: "chillacks_send", arguments: { text: BROADCAST } });
await settle(700);
check("bob received the broadcast", inbox[B].length === 1, `got ${inbox[B].length}`);
check("alice did not receive her own message", inbox[A].length === 0);
if (inbox[B][0]) {
  check(
    "content survived the round trip",
    inbox[B][0].content === BROADCAST,
    JSON.stringify(inbox[B][0].content),
  );
  check(
    "meta carries sender and scope",
    inbox[B][0].meta?.from === A && inbox[B][0].meta?.scope === "room",
    JSON.stringify(inbox[B][0].meta),
  );
}

// 4. direct message: bob -> alice only
await bob.callTool({
  name: "chillacks_send",
  arguments: { to: A, text: "here. what do you need?" },
});
await settle(700);
check("alice received the direct message", inbox[A].length === 1, `got ${inbox[A].length}`);
check("bob got no extra copies", inbox[B].length === 1, `got ${inbox[B].length}`);
if (inbox[A][0]) {
  check(
    "direct message tagged scope=direct",
    inbox[A][0].meta?.scope === "direct",
    JSON.stringify(inbox[A][0].meta),
  );
}

// 5. a direct message to an agent who isn't here reaches nobody
const before = inbox[A].length + inbox[B].length;
const out = await alice.callTool({
  name: "chillacks_send",
  arguments: { to: `${NS}-carol`, text: "carol?" },
});
await settle(500);
check(
  "message to an absent agent is delivered to 0",
  inbox[A].length + inbox[B].length === before &&
    /\(0 recipient/.test(out.content?.[0]?.text ?? ""),
  out.content?.[0]?.text,
);

// 6. roster tool
const rt = await bob.callTool({ name: "chillacks_roster", arguments: {} });
check(
  "roster tool sees both",
  rt.content[0].text.includes(A) && rt.content[0].text.includes(B),
  rt.content[0].text,
);

// 7. selftest echoes back to the sender — the ONLY message that does. This is
//    how a session proves it can actually receive, rather than assuming.
const beforeSelf = inbox[A].length;
await alice.callTool({ name: "chillacks_selftest", arguments: {} });
await settle(700);
const echoed = inbox[A].slice(beforeSelf);
check("selftest echoes back to the sender", echoed.length === 1, `got ${echoed.length}`);
check(
  "selftest echo carries a token and is self-addressed",
  /chillacks selftest [a-z0-9]{6}/.test(echoed[0]?.content ?? "") &&
    echoed[0]?.meta?.from === A,
  JSON.stringify(echoed[0]?.content),
);
check("bob did not see the selftest", inbox[B].length === 1, `got ${inbox[B].length}`);

// 8. lurker: loaded from .mcp.json but never named, so never in the room
inbox.lurker = [];
const roomBefore = await roster();
const lurker = await spawnAgent(null, "lurker"); // null = no CHILLACKS_AGENT
await settle(900);
const withLurker = await roster();
// Compare the whole roster, not a name prefix. The prefix version passed while
// the lurker was in fact sitting in the room under the name "lurker".
check(
  "unnamed session does not join the room",
  withLurker.length === roomBefore.length &&
    roomBefore.every((m) => withLurker.includes(m)),
  `before=[${roomBefore.join(", ")}] after=[${withLurker.join(", ")}]`,
);
const lst = await lurker.callTool({ name: "chillacks_selftest", arguments: {} });
check(
  "lurker selftest reports NOT JOINED",
  /NOT JOINED/.test(lst.content[0].text),
  lst.content[0].text.slice(0, 60),
);
await lurker.close();

await alice.close();
await bob.close();
await settle(800);
const left = await roster();
// Scoped to OUR agents — the room may legitimately hold live sessions.
check(
  "our agents left on disconnect",
  !left.includes(A) && !left.includes(B),
  `roster=[${left.join(", ")}]`,
);
// The invariant we actually control: this run never CLAIMED a live agent's name,
// so it cannot have evicted one. Asserting bystanders are still present instead
// would fail whenever an unrelated agent legitimately disconnects mid-run — a
// confident FAIL with no defect behind it, which is worse than no check.
check(
  "no live agent's name was claimed",
  !bystanders.includes(A) && !bystanders.includes(B),
  `ours=[${A}, ${B}] live=[${bystanders.join(", ") || "none"}]`,
);
const departed = bystanders.filter((b) => !left.includes(b));
if (departed.length) console.log(`  note: ${departed.join(", ")} left during the run (not ours)`);

// 9. the archive is the record — every message this run sent must be on disk,
//    and the integrity checker must agree the log is sound.
const archiveFile = process.env.CHILLACKS_ARCHIVE
  ? nodePath.join(process.env.CHILLACKS_ARCHIVE, "room.jsonl")
  : nodePath.join(os.homedir(), ".stewards", "chillacks", "room.jsonl");
if (fs.existsSync(archiveFile)) {
  const logged = fs
    .readFileSync(archiveFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((m) => m.from === A || m.from === B);
  // broadcast + direct + absent-recipient + selftest = 4 sent by our agents
  check("every message this run sent is on disk", logged.length === 4, `found ${logged.length}`);
  check(
    "archived text matches what was sent",
    logged.some((m) => m.text === BROADCAST),
    logged.map((m) => m.text.slice(0, 24)).join(" | "),
  );
  const chk = spawnSync(process.execPath, ["check-archive.mjs", archiveFile], {
    encoding: "utf8",
  });
  check(
    "archive integrity check passes",
    chk.status === 0,
    (chk.stdout || "").trim().split("\n").pop(),
  );
} else {
  check("archive file exists", false, archiveFile);
}

// 10. the browser vector. Demonstrated live on 2026-07-27: a cross-origin POST
//     carrying text/plain is a CORS "simple request", needs no preflight, was
//     accepted, impersonated the foreman, and reached a steward. These two
//     assertions are that attack, and they must stay red-if-reintroduced.
async function rawPost(headers, body) {
  const r = await fetch(`${HUB}/send`, { method: "POST", headers, body });
  return r.status;
}
// Measure the delta. A hardcoded expected count is a number counted in someone's
// head, and it failed here for exactly that reason while the fix was working.
const beforeInject = inbox[A].length;
const originStatus = await rawPost(
  { Origin: "https://evil.example", "Content-Type": "text/plain;charset=UTF-8" },
  JSON.stringify({ from: "workspace-basecamp", to: A, text: "injected from a web page" }),
);
check("cross-origin POST is refused", originStatus === 403, `status ${originStatus}`);

const ctStatus = await rawPost(
  { "Content-Type": "text/plain;charset=UTF-8" },
  JSON.stringify({ from: "workspace-basecamp", to: A, text: "simple-request injection" }),
);
check("non-JSON content-type is refused", ctStatus === 403, `status ${ctStatus}`);

await settle(400);
check(
  "neither injection reached an agent",
  inbox[A].length === beforeInject,
  `alice inbox ${beforeInject} -> ${inbox[A].length}`,
);

console.log(`\n${fails === 0 ? "ALL PASS" : fails + " FAILED"}`);
// Set exitCode and let the loop drain. Calling process.exit() here trips a
// libuv assertion on Windows (UV_HANDLE_CLOSING in async.c) because the stdio
// child handles are still mid-close — which corrupts the exit code and makes
// this useless as an oracle.
process.exitCode = fails === 0 ? 0 : 1;

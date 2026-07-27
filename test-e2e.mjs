#!/usr/bin/env node
/* test-e2e.mjs — prove two shims can talk through the hub.
 *
 * Drives channel.mjs with the SDK's own Client over stdio, which is the same
 * protocol side Claude Code implements. This verifies everything except Claude
 * Code's own rendering of the <channel> tag.
 *
 * Requires the hub to already be running.  Exits non-zero on failure.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HUB = "http://127.0.0.1:8790";
const inbox = { alice: [], bob: [] };
let fails = 0;

function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) fails++;
}

async function spawnAgent(name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["channel.mjs"],
    env: { ...process.env, CHILLACKS_AGENT: name },
    stderr: "ignore",
  });
  const client = new Client({ name: `test-${name}`, version: "0" }, { capabilities: {} });
  // NB: fallbackNotificationHandler is a public property on Protocol, NOT a
  // constructor option — passing it in the options object is silently ignored.
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") inbox[name].push(n.params);
  };
  await client.connect(transport);
  return client;
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("--- chillacks e2e ---\n");

const alice = await spawnAgent("alice");
const bob = await spawnAgent("bob");
await settle(1200); // let both SSE streams register

// 1. both joined
const roster = await (await fetch(`${HUB}/roster`)).json();
check(
  "both agents joined the room",
  roster.members.includes("alice") && roster.members.includes("bob"),
  `roster=[${roster.members.join(", ")}]`,
);

// 2. tools discovered
const tools = (await alice.listTools()).tools.map((t) => t.name).sort();
check(
  "reply tools exposed",
  tools.join(",") === "chillacks_roster,chillacks_send",
  tools.join(","),
);

// 3. broadcast: alice -> room, bob receives, alice does not echo
await alice.callTool({
  name: "chillacks_send",
  arguments: { text: "bob, are you there?" },
});
await settle(700);
check("bob received the broadcast", inbox.bob.length === 1, `got ${inbox.bob.length}`);
check("alice did not receive her own message", inbox.alice.length === 0);
if (inbox.bob[0]) {
  check(
    "content survived the round trip",
    inbox.bob[0].content === "bob, are you there?",
    JSON.stringify(inbox.bob[0].content),
  );
  check(
    "meta carries sender and scope",
    inbox.bob[0].meta?.from === "alice" && inbox.bob[0].meta?.scope === "room",
    JSON.stringify(inbox.bob[0].meta),
  );
}

// 4. direct message: bob -> alice only
await bob.callTool({
  name: "chillacks_send",
  arguments: { to: "alice", text: "here. what do you need?" },
});
await settle(700);
check("alice received the direct message", inbox.alice.length === 1, `got ${inbox.alice.length}`);
check("bob got no extra copies", inbox.bob.length === 1, `got ${inbox.bob.length}`);
if (inbox.alice[0]) {
  check(
    "direct message tagged scope=direct",
    inbox.alice[0].meta?.scope === "direct",
    JSON.stringify(inbox.alice[0].meta),
  );
}

// 5. a direct message to a third party reaches nobody present
const before = inbox.alice.length + inbox.bob.length;
const out = await alice.callTool({
  name: "chillacks_send",
  arguments: { to: "carol", text: "carol?" },
});
await settle(500);
check(
  "message to an absent agent is delivered to 0",
  inbox.alice.length + inbox.bob.length === before,
  out.content?.[0]?.text,
);

// 6. roster tool
const rt = await bob.callTool({ name: "chillacks_roster", arguments: {} });
check(
  "roster tool sees both",
  /alice/.test(rt.content[0].text) && /bob/.test(rt.content[0].text),
  rt.content[0].text,
);

await alice.close();
await bob.close();
await settle(600);
const after = await (await fetch(`${HUB}/roster`)).json();
check("room empties on disconnect", after.count === 0, `count=${after.count}`);

console.log(`\n${fails === 0 ? "ALL PASS" : fails + " FAILED"}`);
// Set exitCode and let the loop drain. Calling process.exit() here trips a
// libuv assertion on Windows (UV_HANDLE_CLOSING in async.c) because the stdio
// child handles are still mid-close — which corrupts the exit code and makes
// this useless as an oracle.
process.exitCode = fails === 0 ? 0 : 1;

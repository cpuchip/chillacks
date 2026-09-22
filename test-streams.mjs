#!/usr/bin/env node
/* test-streams.mjs: one seat name may hold several streams; an unknown name is
 * named as unknown; every log line is dated.
 *
 * Why (2026-09-22): a scheduled session on another box inherited a seat name
 * from its environment, joined without the channel flag, and the hub's
 * newest-wins eviction handed the seat to a session that could not hear. A DM
 * counted as "1 recipient" reached nobody. Separately, six DMs to a shortened
 * seat name returned "0 recipients" and looked archived. And the hub log had no
 * timestamps, so neither could be dated.
 *
 * Wire-level, on an isolated hub with its own port, archive and tokens.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const PORT = await freePort();
const HUB = `http://127.0.0.1:${PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chillacks-streams-"));
const TOKENS_FILE = path.join(DIR, "tokens.json");

const A = "alice", B = "bob", C = "carol";
const TOK = {
  [A]: "streams-token-alice-aaaaaaaa",
  [B]: "streams-token-bob-bbbbbbbbbb",
  [C]: "streams-token-carol-cccccccc",
};
fs.writeFileSync(TOKENS_FILE, JSON.stringify(TOK));
// A sender the archive remembers but no token names: known by history alone.
fs.writeFileSync(
  path.join(DIR, "room.jsonl"),
  JSON.stringify({ id: 1, from: "ghost", to: null, text: "was here", ts: "2026-09-01T00:00:00.000Z" }) + "\n",
);

let fails = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) fails++;
};
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

const hub = spawn(process.execPath, ["hub.mjs"], {
  env: { ...process.env, CHILLACKS_PORT: String(PORT), CHILLACKS_ARCHIVE: DIR, CHILLACKS_TOKENS: TOKENS_FILE },
  stdio: ["ignore", "ignore", "pipe"],
});
hub.log = "";
hub.stderr.on("data", (d) => (hub.log += d));
const cleanup = () => {
  try { hub.kill(); } catch {}
  fs.rmSync(DIR, { recursive: true, force: true });
};
process.on("exit", cleanup);
for (let i = 0; i < 25 && !/chillacks hub/.test(hub.log); i++) await settle(150);
if (!/chillacks hub/.test(hub.log)) {
  console.error(`hub failed to start:\n${hub.log}`);
  process.exit(2);
}

const hdr = (agent) => ({ "content-type": "application/json", "x-chillacks-token": TOK[agent] });
const post = async (agent, p, body) => {
  const r = await fetch(`${HUB}${p}`, { method: "POST", headers: hdr(agent), body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
};
const roster = async () => (await fetch(`${HUB}/roster`, { headers: hdr(B) })).json();

/** Open one SSE stream; returns its inbox and an abort handle. */
async function listen(agent) {
  const ctrl = new AbortController();
  const inbox = [];
  const res = await fetch(`${HUB}/stream?agent=${agent}`, { headers: hdr(agent), signal: ctrl.signal });
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of frame.split("\n"))
          if (line.startsWith("data: ")) inbox.push(JSON.parse(line.slice(6)));
      }
    }
  })();
  return { inbox, close: () => ctrl.abort() };
}

// ── every log line is dated ─────────────────────────────────────────────────
const lines = hub.log.split("\n").filter(Boolean);
check(
  "hub log lines start with an ISO timestamp",
  lines.length > 0 && lines.every((l) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /.test(l)),
  lines[0]?.slice(0, 60),
);

// ── two streams, one seat ───────────────────────────────────────────────────
const a1 = await listen(A);
const a2 = await listen(A); // a second session carrying the same name
const b = await listen(B);
await settle(400);

const s1 = await post(B, "/send", { to: A, text: "to both of you" });
await settle();
check("first stream still receives after a second joins", a1.inbox.some((m) => m.text === "to both of you"));
check("second stream receives too", a2.inbox.some((m) => m.text === "to both of you"));
check("a seat with two streams counts as one recipient", s1.delivered_to === 1, `got ${s1.delivered_to}`);
const r1 = await roster();
check("roster lists the name once", r1.members.filter((n) => n === A).length === 1 && r1.count === 2, r1.members.join(","));
check("hub log says the name holds 2 streams", /alice holds 2 streams/.test(hub.log));
check("hub log never evicts", !/evicting/.test(hub.log));

const s2 = await post(A, "/send", { text: "all hands" });
await settle();
check("#all counts names, not streams", s2.delivered_to === 1, `got ${s2.delivered_to}`);

// ── one stream leaves, the seat stays ───────────────────────────────────────
a1.close();
await settle(400);
const s3 = await post(B, "/send", { to: A, text: "after one left" });
await settle();
check("the remaining stream still receives", a2.inbox.some((m) => m.text === "after one left"));
check("still one recipient", s3.delivered_to === 1, `got ${s3.delivered_to}`);
check("roster still lists the seat", (await roster()).members.includes(A));
check("hub log notes one stream remains", /- alice  \(\d+ present, 1 stream\(s\) remain\)/.test(hub.log));

a2.close();
await settle(400);
check("last stream gone, seat gone", !(await roster()).members.includes(A));
const s4 = await post(B, "/send", { to: A, text: "nobody home" });
check("absent but known: 0 recipients, not unknown", s4.delivered_to === 0 && s4.unknown === undefined, JSON.stringify(s4));

// ── unknown names are named ─────────────────────────────────────────────────
const u1 = await post(B, "/send", { to: "alic", text: "typo" });
check("unknown name is flagged", u1.ok === true && u1.delivered_to === 0 && u1.unknown === true, JSON.stringify(u1));
check("suggestion finds the near name", Array.isArray(u1.suggest) && u1.suggest.includes(A), JSON.stringify(u1.suggest));
const u2 = await post(B, "/send", { to: "camp", text: "short form" });
check("a shortened name suggests nothing wrong when nothing matches", u2.unknown === true && u2.suggest.length === 0, JSON.stringify(u2.suggest));
const u3 = await post(B, "/send", { to: C, text: "token holder, never online" });
check("a token holder who never connected is known", u3.delivered_to === 0 && u3.unknown === undefined, JSON.stringify(u3));
const u4 = await post(B, "/send", { to: "ghost", text: "archive remembers you" });
check("a past sender from the archive is known", u4.delivered_to === 0 && u4.unknown === undefined, JSON.stringify(u4));
check("hub log marks the unknown send", /bob -> alic \[0\] UNKNOWN SEAT/.test(hub.log));

// ── the record is intact ────────────────────────────────────────────────────
const arch = fs.readFileSync(path.join(DIR, "room.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
check("unknown-name DMs are still archived", arch.some((m) => m.to === "alic" && m.text === "typo"));

b.close();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exitCode = fails === 0 ? 0 : 1;
hub.kill();

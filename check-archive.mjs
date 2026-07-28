#!/usr/bin/env node
/* check-archive.mjs — deterministic integrity check on the room's record.
 *
 * The archive is only worth having if you can prove it wasn't quietly losing
 * messages. This is that proof: no judgment, no model, just arithmetic on the
 * log. Exit 0 = sound, exit 1 = something is wrong and it says what.
 *
 * Checks, in order of how badly each would mislead you:
 *   - every line parses                 (a torn write is survivable; silence isn't)
 *   - ids strictly increase, no dupes   (a repeat means two hubs wrote at once)
 *   - no gaps in the id sequence        (a gap means a message was lost)
 *   - required fields present and typed
 *   - timestamps never go backwards
 *
 * Usage: check-archive.mjs [path]   (default ~/.stewards/chillacks/room.jsonl)
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ARCHIVE =
  process.argv[2] ||
  process.env.CHILLACKS_ARCHIVE_FILE ||
  path.join(
    process.env.CHILLACKS_ARCHIVE || path.join(os.homedir(), ".stewards", "chillacks"),
    "room.jsonl",
  );

if (!fs.existsSync(ARCHIVE)) {
  console.log(`no archive at ${ARCHIVE} — nothing to check`);
  process.exit(0);
}

const lines = fs.readFileSync(ARCHIVE, "utf8").split("\n");
const problems = [];
const msgs = [];

lines.forEach((line, i) => {
  if (!line.trim()) {
    // A trailing newline is normal; a blank line in the middle is not.
    if (i !== lines.length - 1) problems.push(`line ${i + 1}: blank line mid-file`);
    return;
  }
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    problems.push(`line ${i + 1}: does not parse`);
    return;
  }
  if (!Number.isInteger(m.id)) problems.push(`line ${i + 1}: id is not an integer`);
  if (typeof m.from !== "string" || !m.from) problems.push(`line ${i + 1}: missing from`);
  if (typeof m.text !== "string") problems.push(`line ${i + 1}: missing text`);
  if (m.to !== null && typeof m.to !== "string") problems.push(`line ${i + 1}: bad to`);
  if (typeof m.ts !== "string" || Number.isNaN(Date.parse(m.ts)))
    problems.push(`line ${i + 1}: bad timestamp`);
  msgs.push({ ...m, line: i + 1 });
});

for (let i = 1; i < msgs.length; i++) {
  const prev = msgs[i - 1];
  const cur = msgs[i];
  if (cur.id === prev.id)
    problems.push(`line ${cur.line}: duplicate id ${cur.id} — two hubs writing at once?`);
  else if (cur.id < prev.id)
    problems.push(`line ${cur.line}: id ${cur.id} goes backwards after ${prev.id}`);
  else if (cur.id !== prev.id + 1)
    problems.push(
      `line ${cur.line}: gap — id jumps ${prev.id} -> ${cur.id} (${cur.id - prev.id - 1} lost)`,
    );
  if (Date.parse(cur.ts) < Date.parse(prev.ts))
    problems.push(`line ${cur.line}: timestamp goes backwards`);
}

const senders = [...new Set(msgs.map((m) => m.from))];
console.log(`archive:  ${ARCHIVE}`);
console.log(`messages: ${msgs.length}${msgs.length ? `  (id ${msgs[0].id}..${msgs[msgs.length - 1].id})` : ""}`);
console.log(`senders:  ${senders.join(", ") || "(none)"}`);

if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems.slice(0, 20)) console.log(`  ${p}`);
  if (problems.length > 20) console.log(`  ... and ${problems.length - 20} more`);
  process.exitCode = 1;
} else {
  console.log("\nARCHIVE SOUND");
  process.exitCode = 0;
}

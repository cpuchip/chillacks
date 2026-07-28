#!/usr/bin/env node
/* tokens.mjs — mint and list per-agent tokens.
 *
 * Identity is what makes `from` mean anything. Without it, any process on the
 * box can claim to be the foreman, and under the escalation rules a foreman
 * message is direction.
 *
 *   node tokens.mjs add music-steward     # mint (prints the launch line)
 *   node tokens.mjs list                  # names only, never values
 *   node tokens.mjs rm music-steward
 *
 * Tokens live in <archive>/tokens.json, owner-readable, and are NEVER printed
 * by `list` — the launch line from `add` is the one time a value is shown.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const DIR = process.env.CHILLACKS_ARCHIVE || path.join(os.homedir(), ".stewards", "chillacks");
const FILE = process.env.CHILLACKS_TOKENS || path.join(DIR, "tokens.json");

const load = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {});
const save = (t) => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(t, null, 2) + "\n", { mode: 0o600 });
};

const [cmd, name] = process.argv.slice(2);
const tokens = load();

if (cmd === "add") {
  if (!name) {
    console.error("usage: tokens.mjs add <agent-name>");
    process.exit(2);
  }
  if (tokens[name]) {
    console.error(`"${name}" already has a token. Remove it first to rotate.`);
    process.exit(2);
  }
  const tok = crypto.randomBytes(24).toString("base64url");
  tokens[name] = tok;
  save(tokens);
  console.log(`minted for "${name}". Launch that session with:\n`);
  console.log(`  $env:CHILLACKS_AGENT="${name}"`);
  console.log(`  $env:CHILLACKS_TOKEN="${tok}"`);
  console.log(`  claude --dangerously-load-development-channels server:chillacks\n`);
  console.log(`Stored in ${FILE} (mode 600). It is not printed again.`);
} else if (cmd === "list") {
  const names = Object.keys(tokens);
  console.log(FILE);
  console.log(names.length ? names.map((n) => `  ${n}`).join("\n") : "  (no agents)");
} else if (cmd === "rm") {
  if (!tokens[name]) {
    console.error(`no token for "${name}"`);
    process.exit(1);
  }
  delete tokens[name];
  save(tokens);
  console.log(`removed "${name}" — that session loses access at its next reconnect`);
} else {
  console.error("usage: tokens.mjs add <name> | list | rm <name>");
  process.exit(2);
}

#!/usr/bin/env node
/* test-tokens-managed.mjs: tokens.mjs refuses to hand-edit a tokens.json that a
 * roster projects (marker file `tokens.managed` beside it), and still works when
 * no marker exists or --force is given. 8 checks, own temp archive, no hub.
 *
 * Why (2026-09-27): twice in one week a seat was minted with `tokens.mjs add` on
 * a box whose tokens.json is a projection of a roster; the next projection
 * refused to run rather than drop the stray seat, and a pairing failed on it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) fails++;
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chillacks-tokens-"));
const run = (...args) =>
  spawnSync(process.execPath, [path.join(HERE, "tokens.mjs"), ...args], {
    env: { ...process.env, CHILLACKS_ARCHIVE: dir },
    encoding: "utf8",
  });
const names = () => Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "tokens.json"), "utf8")));

try {
  // unmanaged: add and rm work as before
  let r = run("add", "alice");
  check("unmanaged: add mints", r.status === 0 && names().includes("alice"), `exit ${r.status}`);
  check("unmanaged: the minted value is printed once, in the launch line", /CHILLACKS_TOKEN="/.test(r.stdout));

  // managed: a projector left its marker
  fs.writeFileSync(path.join(dir, "tokens.managed"), "projected by roster.py render\nmint: roster.py add-seat <name>\n");
  r = run("add", "bob");
  check("managed: add refuses (exit 2)", r.status === 2, `exit ${r.status}`);
  check("managed: the refusal prints the marker's own instructions", /roster\.py add-seat/.test(r.stderr));
  check("managed: nothing was minted", !names().includes("bob"), names().join(","));
  r = run("rm", "alice");
  check("managed: rm refuses too", r.status === 2 && names().includes("alice"), `exit ${r.status}`);
  r = run("rm", "alice", "--force");
  check("managed: --force overrides, once, explicitly", r.status === 0 && !names().includes("alice"), `exit ${r.status}`);
  check("list still works under a marker", run("list").status === 0);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);

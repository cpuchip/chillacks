#!/usr/bin/env node
/* test-monitor.mjs — the box monitor's sample, checked against the box's own tools.
 *
 * The monitor reads /proc, statfs and cgroups; this checks the same figures with
 * different instruments (free, df, nproc, nvidia-smi, docker stats, ps), which is
 * the by-hand check made repeatable. Two child processes are planted: one that
 * rewrites its own title the way postgres does, and one whose first argument is a
 * flag carrying a value. Neither may leak past the executable's name and a flag's
 * name.
 *
 * Linux only: on any other platform it prints why and exits 0.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.platform !== "linux") {
  console.log(`SKIP  test-monitor: the monitor's sources here are Linux's (/proc, statfs, cgroup v2); this is ${process.platform}`);
  process.exit(0);
}

const { sample, redactArg } = await import("./monitor.mjs");

let fails = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) fails++;
};
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
const GiB = 2 ** 30;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ── redaction, by rule ─────────────────────────────────────────────────────
for (const [arg, want] of [
  ["script.py", "script.py"],
  ["-m", "-m"],
  ["--max-old-space-size=100", "--max-old-space-size"],
  ["--api-key=hunter2", "--api-key"],
  ["--token", "--token"],
  // token fixtures are synthetic on purpose (one repeated character, or built at
  // run time), so no secret scanner has to decide whether a test holds a credential
  ["sk-" + "x".repeat(40), "<redacted>"],
  ["Ab1".repeat(10), "<redacted>"],
  ["password123", "<redacted>"],
  ["my_secret.txt", "<redacted>"],
  ["ghp_" + "x".repeat(36), "<redacted>"],
  ["github_pat_" + "x".repeat(70), "<redacted>"],
  ["AKIA" + "X".repeat(16), "<redacted>"],
  ["deadbeefdeadbeefdeadbeefdeadbeef0123", "<redacted>"],
  ["/home/dev/code/some-long-project-workspace-name/projects/app/channel.mjs", "/home/dev/code/some-long-project-workspace-name/projects/app/channel.mjs"],
  ["/srv/app/main.py", "/srv/app/main.py"],
  // a seat launched with its first prompt as argv[1]: the whole brief, prose with no secret word in it
  ["You are the seat probe on box boxa. Read your charter first, then the brief.", "<text>"],
  ["/" + "a".repeat(130), "<long>"],
]) check(`redactArg(${JSON.stringify(arg)}) is ${JSON.stringify(want)}`, redactArg(arg) === want, JSON.stringify(redactArg(arg)));

// ── two planted processes ──────────────────────────────────────────────────
const titled = spawn(process.execPath, ["-e",
  'process.title = "hwprobe --api-key=hunter2 user=secretdb"; const b = Buffer.alloc(64 * 2 ** 20, 1); setInterval(() => b[0]++, 1000);'],
  { stdio: "ignore" });
const flagged = spawn(process.execPath, ["--max-old-space-size=100", "-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
// the brief case on the real path: a first argument with spaces in it (a script whose name is prose)
const proseDir = fs.mkdtempSync(path.join(os.tmpdir(), "mon-prose-"));
const proseScript = path.join(proseDir, "You are the seat probe read your charter first.mjs");
fs.writeFileSync(proseScript, "setInterval(() => {}, 1000);\n");
const prose = spawn(process.execPath, [proseScript], { stdio: "ignore" });
// argv[0] rewritten to a title while the real arguments stay behind it
const retitled = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore", argv0: "hw: title user=secretdb" });
process.on("exit", () => { for (const c of [titled, flagged, prose, retitled]) try { c.kill(); } catch {} fs.rmSync(proseDir, { recursive: true, force: true }); });
await new Promise((r) => setTimeout(r, 800));

// three services: one healthy, one answering 503 (running, still loading), one not listening
import http from "node:http";
const serve = (code) => new Promise((r) => { const sv = http.createServer((_q, w) => { w.writeHead(code); w.end(); }); sv.listen(0, "127.0.0.1", () => r(sv)); });
const up = await serve(200), loading = await serve(503);
const closed = await new Promise((r) => { const sv = http.createServer(); sv.listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => r(p)); }); });
const services = [
  { name: "svc-up", url: `http://127.0.0.1:${up.address().port}/health` },
  { name: "svc-loading", url: `http://127.0.0.1:${loading.address().port}/health` },
  { name: "svc-down", url: `http://127.0.0.1:${closed}/health` },
];

// ── one sample, taken now, and the box's own tools right after ─────────────
const s = await sample({ box: "testbox", top: 2000, disks: ["/"], services });
up.close(); loading.close();
const svc = Object.fromEntries((s.services || []).map((x) => [x.name, x]));
check("a service whose health answers 200 is healthy", svc["svc-up"]?.healthy === true, JSON.stringify(s.services));
check("a service answering 503 is not (running, not ready)", svc["svc-loading"]?.healthy === false && svc["svc-loading"]?.status === 503, JSON.stringify(svc["svc-loading"]));
check("a service not listening is not", svc["svc-down"]?.healthy === false && svc["svc-down"]?.status === null, JSON.stringify(svc["svc-down"]));
check("a health URL is not in the sample", !JSON.stringify(s.services).includes("127.0.0.1"));
const free = sh("free", ["-b"]);
const memLine = free?.split("\n").find((l) => l.startsWith("Mem:"))?.split(/\s+/);
const swapLine = free?.split("\n").find((l) => l.startsWith("Swap:"))?.split(/\s+/);

check("the record has v, box, ts, interval and its own cost", s.v === 1 && s.box === "testbox" && !Number.isNaN(Date.parse(s.ts)) && s.sample_ms > 0, JSON.stringify({ v: s.v, box: s.box, ts: s.ts, sample_ms: s.sample_ms }));
check("a sample costs under a second", s.sample_ms < 1000, `${s.sample_ms} ms`);
if (memLine) {
  check("mem.total matches free -b", near(s.mem.total_gib, Number(memLine[1]) / GiB, 0.01), `${s.mem.total_gib} vs ${(Number(memLine[1]) / GiB).toFixed(3)}`);
  check("mem.available matches free -b within 0.5 GiB", near(s.mem.available_gib, Number(memLine[6]) / GiB, 0.5), `${s.mem.available_gib} vs ${(Number(memLine[6]) / GiB).toFixed(3)}`);
  check("mem.shmem matches free -b's shared within 0.2 GiB", near(s.mem.shmem_gib, Number(memLine[4]) / GiB, 0.2), `${s.mem.shmem_gib} vs ${(Number(memLine[4]) / GiB).toFixed(3)}`);
  check("mem.swap_used matches free -b within 0.2 GiB", near(s.mem.swap_used_gib, Number(swapLine[2]) / GiB, 0.2), `${s.mem.swap_used_gib} vs ${(Number(swapLine[2]) / GiB).toFixed(3)}`);
} else check("free -b is available to check against", false);

const df = (m) => { const l = sh("df", ["-B1", "--output=used,size", m])?.trim().split("\n")[1]?.trim().split(/\s+/); return l ? { used: Number(l[0]) / GiB, size: Number(l[1]) / GiB } : null; };
for (const m of ["/dev/shm", "/tmp"]) {
  const t = s.tmpfs.find((x) => x.mount === m), d = df(m);
  if (t && d) check(`tmpfs ${m} matches df -B1 within 0.1 GiB`, near(t.used_gib, d.used, 0.1) && near(t.size_gib, d.size, 0.1), `${t.used_gib}/${t.size_gib} vs ${d.used.toFixed(3)}/${d.size.toFixed(3)}`);
  else if (fs.existsSync(m) && d) check(`tmpfs ${m} is reported`, false, JSON.stringify(s.tmpfs));
}
const root = s.disk.find((x) => x.mount === "/"), droot = df("/");
check("disk / matches df -B1 within 1 GiB", root && droot && near(root.used_gib, droot.used, 1) && near(root.size_gib, droot.size, 1), `${root?.used_gib}/${root?.size_gib} vs ${droot?.used.toFixed(1)}/${droot?.size.toFixed(1)}`);
check("load.cpus matches nproc --all", s.load.cpus === Number(sh("nproc", ["--all"])), `${s.load.cpus}`);
check("load figures are numbers", [s.load.load1, s.load.load5].every((x) => Number.isFinite(x)));

const smiL = sh("nvidia-smi", ["-L"]);
if (smiL) {
  const uuids = [...smiL.matchAll(/UUID: (GPU-[0-9a-f-]+)/g)].map((m) => m[1]);
  check("one gpu entry per card nvidia-smi -L lists, by UUID", s.gpu.length === uuids.length && uuids.every((u) => s.gpu.some((g) => g.uuid === u)), JSON.stringify(s.gpu.map((g) => g.uuid)));
  const appPids = (sh("nvidia-smi", ["--query-compute-apps=pid", "--format=csv,noheader"]) || "").trim().split("\n").filter(Boolean).map(Number);
  check("every compute app nvidia-smi lists is on its card", appPids.every((p) => s.gpu.some((g) => g.apps.some((a) => a.pid === p))), `${JSON.stringify(appPids)} vs ${JSON.stringify(s.gpu.map((g) => g.apps.map((a) => a.pid)))}`);
} else check("no nvidia-smi: gpu is empty", Array.isArray(s.gpu) && s.gpu.length === 0, JSON.stringify(s.gpu));

// top, against ps, and the two planted processes
check("top is sorted by RSS, largest first", s.top.every((p, i) => i === 0 || s.top[i - 1].rss_gib >= p.rss_gib));
const big = s.top[0];
const psRss = Number(sh("ps", ["-o", "rss=", "-p", String(big?.pid)])) * 1024 / GiB;
check("the largest process's RSS matches ps within 5%", big && near(big.rss_gib, psRss, Math.max(0.01, psRss * 0.05)), `${big?.rss_gib} vs ${psRss.toFixed(3)} (pid ${big?.pid})`);
const t1 = s.top.find((p) => p.pid === titled.pid), t2 = s.top.find((p) => p.pid === flagged.pid);
check("a process that rewrote its title shows its name only", t1 && t1.exe === "hwprobe" && t1.arg1 === undefined, JSON.stringify(t1));
check("and its RSS is seen (64 MiB planted)", t1 && t1.rss_gib >= 0.06, JSON.stringify(t1));
check("a flag's value does not leave the box", t2 && t2.exe === "node" && t2.arg1 === "--max-old-space-size", JSON.stringify(t2));
const t4 = s.top.find((p) => p.pid === retitled.pid);
check("a rewritten argv[0] withholds the arguments behind it", t4 && t4.exe === "node" && t4.arg1 === undefined, JSON.stringify(t4));
const t3 = s.top.find((p) => p.pid === prose.pid);
check("a first argument that is prose is reported as <text>", t3 && t3.exe === "node" && t3.arg1 === "<text>", JSON.stringify(t3));
const all = JSON.stringify(s);
check("no planted secret or prose appears anywhere in the sample", !/hunter2|secretdb|api-key=|read your charter/.test(all));
check("the user is a name", t2 && t2.user === os.userInfo().username, JSON.stringify(t2));

// containers, against docker stats (a different instrument from the cgroup files)
const stats = sh("docker", ["stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}"]);
if (stats !== null && stats.trim()) {
  const unit = { B: 1, KiB: 2 ** 10, MiB: 2 ** 20, GiB: GiB, kB: 1e3, MB: 1e6, GB: 1e9 };
  const rows = stats.trim().split("\n").map((l) => { const [name, mu] = l.split("\t"); const m = mu.split(" / ")[0].match(/^([\d.]+)(\w+)$/); return { name, gib: (Number(m[1]) * (unit[m[2]] || 1)) / GiB }; });
  check("one container entry per running container, by name", rows.every((r) => s.containers.some((c) => c.name === r.name)), JSON.stringify(s.containers.map((c) => c.name)));
  const off = rows.filter((r) => { const c = s.containers.find((x) => x.name === r.name); return !c || !near(c.mem_gib, r.gib, Math.max(0.02, r.gib * 0.05)); });
  check("container memory matches docker stats within 5% (or 20 MiB)", off.length === 0, JSON.stringify(off));
  const capped = s.containers.filter((c) => c.limit_gib !== null);
  check("a limit is a number of GiB or null for none", s.containers.every((c) => c.limit_gib === null || c.limit_gib > 0), JSON.stringify(capped.slice(0, 3)));
} else console.log("SKIP  containers: docker is not available to this user");

for (const c of [titled, flagged, prose, retitled]) c.kill();
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL GREEN — the monitor's sample agrees with the box's own tools.");
process.exit(fails ? 1 : 0);

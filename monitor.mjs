#!/usr/bin/env node
/* monitor.mjs — a box's memory, load, disk, GPU and largest processes, for the hub.
 *
 * Every MONITOR_INTERVAL_S it takes one sample and posts it to the hub as the
 * box's monitor identity (a token named monitor-<box>); the hub keeps the latest
 * per box and reads budgets against it (docs/ledger.md, section 4). Zero
 * dependencies, like the hub: every box that carries seats already runs Node.
 *
 *   node monitor.mjs --once     print one sample and post nothing (the by-hand check)
 *   node monitor.mjs            sample and post, forever
 *
 * Env:
 *   CHILLACKS_HUB        hub URL (default http://127.0.0.1:8790)
 *   CHILLACKS_TOKEN      the box's monitor token
 *   MONITOR_BOX          box name (default the hostname)
 *   MONITOR_INTERVAL_S   default 30
 *   MONITOR_TOP          how many of the largest processes to report (default 10)
 *   MONITOR_DISKS        comma-separated mounts (default "/")
 *
 * Linux only for now: /proc, statfs and cgroup v2. A Windows box sends the same
 * record from its own sources, in a later change.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const GiB = 2 ** 30;
const r3 = (x) => Math.round(x * 1000) / 1000;
const TMPFS_MAGIC = 0x01021994;

/** A command's first argument, as far as it may leave the box. A flag keeps its
 *  name and loses its value. Text (anything with whitespace: a seat launched with
 *  its first prompt as argv[1] carries the whole brief there) and anything long
 *  are reported by their shape; anything that names or looks like a secret goes. */
export function redactArg(a) {
  const s = String(a);
  if (s.startsWith("-")) return s.split("=")[0];
  if (/\s/.test(s)) return "<text>";
  if (s.length > 120) return "<long>";
  if (/key|token|secret|passw/i.test(s)) return "<redacted>";
  // credentials that announce themselves by prefix (GitHub, OpenAI and Anthropic style, Slack, AWS, GitLab)
  if (/^(gh[pousr]_|github_pat_|sk-|xox[abpr]-|AKIA|glpat-)/.test(s)) return "<redacted>";
  for (const run of s.match(/[A-Za-z0-9_+=-]{24,}/g) || [])
    if (/\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run)) return "<redacted>";
  if (/[0-9a-fA-F]{32,}/.test(s)) return "<redacted>";
  return s;
}

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};

function meminfo() {
  const t = fs.readFileSync("/proc/meminfo", "utf8");
  const kb = (k) => Number(t.match(new RegExp(`^${k}:\\s+(\\d+)`, "m"))?.[1] ?? 0) * 1024;
  return {
    total_gib: r3(kb("MemTotal") / GiB),
    available_gib: r3(kb("MemAvailable") / GiB),
    swap_used_gib: r3((kb("SwapTotal") - kb("SwapFree")) / GiB),
    shmem_gib: r3(kb("Shmem") / GiB), // tmpfs pages: RSS cannot see them, MemAvailable already excludes them
  };
}

function usage(mount) {
  const s = fs.statfsSync(mount);
  return { mount, used_gib: r3(((s.blocks - s.bfree) * s.bsize) / GiB), size_gib: r3((s.blocks * s.bsize) / GiB), type: s.type };
}

function gpus() {
  const cards = run("nvidia-smi", ["--query-gpu=uuid,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"]);
  if (cards === null) return [];
  const out = cards.trim().split("\n").filter(Boolean).map((l) => {
    const [uuid, util, used, total] = l.split(",").map((x) => x.trim());
    return { uuid, util_pct: Number(util), mem_used_gib: r3((Number(used) * 2 ** 20) / GiB), mem_total_gib: r3((Number(total) * 2 ** 20) / GiB), apps: [] };
  });
  const apps = run("nvidia-smi", ["--query-compute-apps=pid,gpu_uuid,used_memory", "--format=csv,noheader,nounits"]) || "";
  for (const l of apps.trim().split("\n").filter(Boolean)) {
    const [pid, uuid, used] = l.split(",").map((x) => x.trim());
    out.find((c) => c.uuid === uuid)?.apps.push({ pid: Number(pid), mem_gib: r3((Number(used) * 2 ** 20) / GiB) });
  }
  return out;
}

let users = null;
function userName(uid) {
  if (!users) {
    users = new Map();
    try {
      for (const l of fs.readFileSync("/etc/passwd", "utf8").split("\n")) {
        const f = l.split(":");
        if (f.length > 2) users.set(f[2], f[0]);
      }
    } catch {}
  }
  return users.get(String(uid)) ?? String(uid);
}

/** container id -> name, from docker ps where this user may run it */
function dockerNames() {
  const out = run("docker", ["ps", "--no-trunc", "--format", "{{.ID}} {{.Names}}"]);
  const m = new Map();
  for (const l of (out || "").trim().split("\n").filter(Boolean)) {
    const [id, name] = l.split(" ");
    m.set(id, name);
  }
  return m;
}

/** cgroup v2 scopes of docker containers: the systemd driver's and the cgroupfs driver's */
function containerScopes() {
  const out = [];
  for (const [base, re] of [
    ["/sys/fs/cgroup/system.slice", /^docker-([0-9a-f]{64})\.scope$/],
    ["/sys/fs/cgroup/docker", /^([0-9a-f]{64})$/],
  ]) {
    let names = [];
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const n of names) {
      const m = n.match(re);
      if (m) out.push({ id: m[1], dir: path.join(base, n) });
    }
  }
  return out;
}

function containers(names) {
  const out = [];
  for (const { id, dir } of containerScopes()) {
    try {
      const cur = Number(fs.readFileSync(path.join(dir, "memory.current"), "utf8"));
      const inactive = Number(fs.readFileSync(path.join(dir, "memory.stat"), "utf8").match(/^inactive_file (\d+)/m)?.[1] ?? 0);
      const max = fs.readFileSync(path.join(dir, "memory.max"), "utf8").trim();
      // used = current less inactive file cache: the figure docker stats shows
      out.push({ name: names.get(id) ?? id.slice(0, 12), mem_gib: r3((cur - inactive) / GiB), limit_gib: max === "max" ? null : r3(Number(max) / GiB) });
    } catch {} // a container that stopped between the listing and the read
  }
  return out.sort((a, b) => b.mem_gib - a.mem_gib);
}

function topProcesses(n, names) {
  const all = [];
  for (const p of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(p)) continue;
    try {
      const st = fs.readFileSync(`/proc/${p}/status`, "utf8");
      const rss = st.match(/^VmRSS:\s+(\d+)/m);
      if (!rss) continue; // a kernel thread
      all.push({ pid: Number(p), rss: Number(rss[1]) * 1024, uid: st.match(/^Uid:\s+(\d+)/m)?.[1] });
    } catch {} // gone between the listing and the read
  }
  all.sort((a, b) => b.rss - a.rss);
  const out = [];
  for (const p of all.slice(0, n)) {
    try {
      // The executable's name from comm, cut at a space: a process that rewrites
      // its title (postgres puts user, database and client there) leaves comm or
      // cmdline holding the whole title.
      const exe = fs.readFileSync(`/proc/${p.pid}/comm`, "utf8").trim().split(" ")[0];
      const argv = fs.readFileSync(`/proc/${p.pid}/cmdline`, "utf8").split("\0");
      // A first argument only when argv is still argv: a rewritten title is one
      // string with spaces in it, and the rest of the area is padding.
      const arg1 = !argv[0].includes(" ") && argv[1] ? redactArg(argv[1]) : undefined;
      const cg = fs.readFileSync(`/proc/${p.pid}/cgroup`, "utf8").match(/docker-([0-9a-f]{64})\.scope|\/docker\/([0-9a-f]{64})/);
      const cid = cg ? cg[1] || cg[2] : null;
      out.push({
        pid: p.pid,
        user: userName(p.uid),
        rss_gib: r3(p.rss / GiB),
        exe,
        ...(arg1 !== undefined ? { arg1 } : {}),
        ...(cid ? { container: names.get(cid) ?? cid.slice(0, 12) } : {}),
      });
    } catch {}
  }
  return out;
}

/** One sample. Every figure comes from a file read or one short command. */
export async function sample({ box = os.hostname(), top = 10, disks = ["/"], tmpfsMounts = ["/tmp", "/dev/shm"], interval_s = 30 } = {}) {
  const t0 = process.hrtime.bigint();
  const names = dockerNames();
  const load = fs.readFileSync("/proc/loadavg", "utf8").split(" ");
  const tmpfs = tmpfsMounts
    .filter((m) => fs.existsSync(m))
    .map(usage)
    .filter((u) => u.type === TMPFS_MAGIC)
    .map(({ type: _t, ...u }) => u);
  const rec = {
    v: 1,
    box,
    ts: new Date().toISOString(),
    interval_s,
    mem: meminfo(),
    tmpfs,
    load: { load1: Number(load[0]), load5: Number(load[1]), cpus: os.cpus().length },
    disk: disks.filter((m) => fs.existsSync(m)).map(usage).map(({ type: _t, ...u }) => u),
    gpu: gpus(),
    top: topProcesses(top, names),
    containers: containers(names),
  };
  rec.sample_ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10;
  return rec;
}

async function main() {
  if (process.platform !== "linux") {
    console.error(`monitor: this box is ${process.platform}; the Linux sources (/proc, statfs, cgroup v2) are all this file has so far`);
    process.exit(2);
  }
  const opts = {
    box: process.env.MONITOR_BOX || os.hostname(),
    top: Number(process.env.MONITOR_TOP || 10),
    disks: (process.env.MONITOR_DISKS || "/").split(",").map((s) => s.trim()).filter(Boolean),
    interval_s: Number(process.env.MONITOR_INTERVAL_S || 30),
  };
  if (process.argv.includes("--once")) {
    console.log(JSON.stringify(await sample(opts), null, 2));
    return;
  }
  const HUB = process.env.CHILLACKS_HUB || "http://127.0.0.1:8790";
  const headers = { "content-type": "application/json", ...(process.env.CHILLACKS_TOKEN ? { "x-chillacks-token": process.env.CHILLACKS_TOKEN } : {}) };
  console.error(`[monitor] ${opts.box} -> ${HUB} every ${opts.interval_s} s`);
  for (;;) {
    try {
      const r = await fetch(`${HUB}/telemetry`, { method: "POST", headers, body: JSON.stringify(await sample(opts)) });
      if (!r.ok) console.error(`[monitor] hub ${r.status}: ${(await r.text()).slice(0, 200)}`);
    } catch (e) {
      console.error(`[monitor] ${e.message}`); // the hub is down: keep sampling, it comes back
    }
    await new Promise((res) => setTimeout(res, opts.interval_s * 1000));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();

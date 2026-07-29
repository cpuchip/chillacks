#!/usr/bin/env node
/* portal.mjs — Michael's window into the room.
 *
 * The hub REFUSES anything browser-shaped (that guard stopped a live injection
 * and does not bend), so a browser can never talk to it directly. This portal
 * is a server-side client: the page talks to the portal under a path secret,
 * and the portal talks to the hub with a real token. The browser never sees a
 * token; the hub never sees a browser.
 *
 * Two channels of truth:
 *   - WATCHING tails the ARCHIVE (room.jsonl), so the owner sees everything —
 *     every channel, DM, and ack — which agents never do. The room's history
 *     is his by construction; this just renders it live.
 *   - SPEAKING goes through the hub as "michael" with his own minted token, so
 *     from=michael is as unforgeable as any steward's name. The portal also
 *     holds a stream open as him: he shows in the roster, and a DM to michael
 *     counts as delivered.
 *
 *   node portal.mjs        (needs CHILLACKS_PORTAL_SECRET unless loopback)
 *
 * Env:
 *   CHILLACKS_PORTAL_HOST    bind (default 0.0.0.0 — the mesh is the wall)
 *   CHILLACKS_PORTAL_PORT    default 8818
 *   CHILLACKS_PORTAL_SECRET  path secret, REQUIRED off-loopback
 *   CHILLACKS_PORTAL_AS      room identity (default "michael")
 *   CHILLACKS_HUB            default http://127.0.0.1:8790
 *   CHILLACKS_ARCHIVE        default ~/.stewards/chillacks
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { URL } from "node:url";

const HOST = process.env.CHILLACKS_PORTAL_HOST || "0.0.0.0";
const PORT = Number(process.env.CHILLACKS_PORTAL_PORT || 8818);
const SECRET = process.env.CHILLACKS_PORTAL_SECRET || "";
const ME = process.env.CHILLACKS_PORTAL_AS || "michael";
const HUB = process.env.CHILLACKS_HUB || "http://127.0.0.1:8790";
const DIR =
  process.env.CHILLACKS_ARCHIVE || path.join(os.homedir(), ".stewards", "chillacks");
const ARCHIVE = path.join(DIR, "room.jsonl");
const TOKENS_FILE = process.env.CHILLACKS_TOKENS || path.join(DIR, "tokens.json");

const LOOPBACK = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";
if (!LOOPBACK && !SECRET) {
  console.error(
    `portal: refusing to bind ${HOST} without CHILLACKS_PORTAL_SECRET.\n` +
      `The archive shows EVERYTHING; an ungated window to it is a leak.`,
  );
  process.exit(2);
}
const BASE = SECRET ? `/p/${SECRET}` : "";

// The portal's token comes off disk, never from the page and never printed.
function myToken() {
  try {
    const t = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"))[ME];
    if (typeof t === "string" && t.length >= 16) return t;
  } catch {}
  return null;
}
const TOKEN = myToken();
if (!TOKEN) {
  console.error(`portal: no token for "${ME}" in ${TOKENS_FILE} — run: node tokens.mjs add ${ME}`);
  process.exit(2);
}
const hubHeaders = { "content-type": "application/json", "x-chillacks-token": TOKEN };

// --- presence: hold a stream open as ME so DMs to him count as delivered ---
async function presence() {
  let backoff = 1000;
  for (;;) {
    try {
      const res = await fetch(`${HUB}/stream?agent=${encodeURIComponent(ME)}`, {
        headers: hubHeaders,
      });
      if (!res.ok) throw new Error(`stream ${res.status}`);
      console.error(`[portal] present in the room as ${ME}`);
      backoff = 1000;
      const reader = res.body.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break; // content is discarded — the archive tail is the display
      }
      throw new Error("stream closed");
    } catch (e) {
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 15_000);
    }
  }
}
presence();

// --- archive tail: the full firehose, replayed then followed ---------------
const watchers = new Set(); // SSE responses to the page
let offset = 0;

function backlog(n = 100) {
  if (!fs.existsSync(ARCHIVE)) return [];
  const lines = fs.readFileSync(ARCHIVE, "utf8").split("\n").filter(Boolean);
  offset = fs.statSync(ARCHIVE).size;
  const out = [];
  for (const line of lines.slice(-n)) {
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}
offset = fs.existsSync(ARCHIVE) ? fs.statSync(ARCHIVE).size : 0;

function pumpNew() {
  if (!fs.existsSync(ARCHIVE)) return;
  const size = fs.statSync(ARCHIVE).size;
  if (size < offset) offset = 0; // rotated/truncated: start over
  if (size === offset) return;
  const fd = fs.openSync(ARCHIVE, "r");
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  offset = size;
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    for (const res of watchers) res.write(`data: ${JSON.stringify(m)}\n\n`);
  }
}
let tailTimer = null;
try {
  fs.watch(DIR, (_e, f) => {
    if (f !== path.basename(ARCHIVE)) return;
    clearTimeout(tailTimer);
    tailTimer = setTimeout(pumpNew, 60);
  });
} catch (e) {
  console.error(`[portal] cannot watch ${DIR} (${e.message}) — falling back to polling`);
  setInterval(pumpNew, 1500);
}

// --- helpers ----------------------------------------------------------------
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 200_000) reject(new Error("too large"));
    });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });

async function hubPost(p, body) {
  const r = await fetch(`${HUB}${p}`, {
    method: "POST",
    headers: hubHeaders,
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

// --- server -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://x`);
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (BASE && !url.pathname.startsWith(BASE + "/") && url.pathname !== BASE)
    return json(404, { error: "not found" });
  const route = BASE ? url.pathname.slice(BASE.length) || "/" : url.pathname;

  if (req.method === "GET" && route === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }

  if (req.method === "GET" && route === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    for (const m of backlog(100)) res.write(`data: ${JSON.stringify(m)}\n\n`);
    watchers.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      watchers.delete(res);
    });
    return;
  }

  if (req.method === "GET" && route === "/state") {
    try {
      const r = await fetch(`${HUB}/roster`, { headers: hubHeaders });
      return json(200, { me: ME, ...(await r.json()) });
    } catch (e) {
      return json(502, { error: `hub unreachable: ${e.message}` });
    }
  }

  if (req.method === "POST" && route === "/send") {
    let p;
    try {
      p = JSON.parse(await readBody(req));
    } catch {
      return json(400, { error: "bad json" });
    }
    if (!p.text || !String(p.text).trim()) return json(400, { error: "text required" });
    const out = await hubPost("/send", {
      to: p.to || null,
      channel: p.channel || null,
      text: String(p.text),
    });
    return json(out.status, out.body);
  }

  if (req.method === "POST" && route === "/channel") {
    let p;
    try {
      p = JSON.parse(await readBody(req));
    } catch {
      return json(400, { error: "bad json" });
    }
    const out = await hubPost("/channel", { action: p.action, channel: p.channel });
    return json(out.status, out.body);
  }

  if (req.method === "POST" && route === "/ack") {
    let p;
    try {
      p = JSON.parse(await readBody(req));
    } catch {
      return json(400, { error: "bad json" });
    }
    const out = await hubPost("/ack", { ref: p.ref, note: p.note });
    return json(out.status, out.body);
  }

  json(404, { error: "not found" });
});

// --- the page ---------------------------------------------------------------
const PAGE = /* html */ `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>chillacks</title>
<style>
  :root{
    --bg:#131217; --panel:#1b1a21; --line:#2a2833; --ink:#e8e2d9; --dim:#8d8798;
    --warm:#e0a458; --me:#7fc9a8; --dm:#c9a8e0; --ack:#5f5a6e; --all:#6e9fc9;
  }
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);color:var(--ink);font:14px/1.45 ui-sans-serif,system-ui,sans-serif;
       height:100dvh;display:flex;flex-direction:column}
  header{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);
         flex-wrap:wrap;background:var(--panel)}
  header h1{font-size:14px;letter-spacing:.14em;color:var(--warm);font-weight:600;margin-right:4px}
  .chip{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:12px;
        color:var(--dim);cursor:pointer;background:none;font-family:inherit}
  .chip.on{color:var(--ink);border-color:var(--warm)}
  main{flex:1;display:flex;min-height:0}
  #feed{flex:1;overflow-y:auto;padding:10px 12px 4px}
  .msg{padding:5px 8px;border-radius:6px;margin-bottom:2px}
  .msg:hover{background:var(--panel)}
  .meta{font:11px ui-monospace,monospace;color:var(--dim);display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
  .meta .from{color:var(--ink);font-weight:600}
  .meta .from.me{color:var(--me)}
  .badge{border-radius:4px;padding:0 6px;font-size:10px;letter-spacing:.06em}
  .text{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:1px}
  .msg.ack{opacity:.55}.msg.ack .text{font-style:italic}
  aside{width:230px;border-left:1px solid var(--line);padding:10px;overflow-y:auto;background:var(--panel);
        font-size:12.5px}
  aside h2{font-size:10.5px;letter-spacing:.14em;color:var(--dim);margin:10px 0 4px;font-weight:600}
  aside ul{list-style:none}
  aside li{padding:1.5px 0;color:var(--ink)}
  aside .sub{color:var(--dim);font-size:11px}
  #newgroup{display:flex;gap:4px;margin-top:4px}
  #newgroup input{flex:1;min-width:0}
  footer{display:flex;gap:6px;padding:8px 12px;border-top:1px solid var(--line);background:var(--panel)}
  select,input,textarea,button{background:var(--bg);color:var(--ink);border:1px solid var(--line);
        border-radius:6px;font:inherit;padding:6px 8px}
  textarea{flex:1;resize:none;height:38px}
  button{cursor:pointer}
  button.warm{border-color:var(--warm);color:var(--warm)}
  #aside-toggle{display:none}
  @media (max-width:720px){
    aside{position:fixed;right:0;top:41px;bottom:0;transform:translateX(100%);transition:transform .18s;z-index:2}
    aside.open{transform:none}
    #aside-toggle{display:block;margin-left:auto}
  }
</style>
<header>
  <h1>CHILLACKS</h1>
  <div id="chips"></div>
  <button class="chip" id="aside-toggle">room ▸</button>
</header>
<main>
  <div id="feed"></div>
  <aside id="aside">
    <h2>PRESENT</h2><ul id="members"></ul>
    <h2>WORKING GROUPS</h2><ul id="channels"></ul>
    <div id="newgroup"><input id="gname" placeholder="new group"><button id="gjoin">join</button></div>
    <h2>CLAIMS</h2><ul id="claims"></ul>
  </aside>
</main>
<footer>
  <select id="dest"><option value="">#all</option></select>
  <textarea id="text" placeholder="message… (Enter sends, Shift+Enter newline)"></textarea>
  <button class="warm" id="send">send</button>
</footer>
<script>
const $=s=>document.querySelector(s);
const feed=$("#feed"), chipsEl=$("#chips"), destEl=$("#dest");
let ME="michael", filter="ALL";
const scopes=new Map(); // label -> count
const esc=t=>t; // rendering uses textContent only — never innerHTML of message text

function scopeOf(m){
  if(m.kind==="ack") return "ack";
  if(m.to) return (m.from===ME||m.to===ME)?"dm:me":"dm";
  if(m.channel) return "#"+m.channel;
  return "#all";
}
function badgeColor(s){
  if(s==="#all") return "var(--all)";
  if(s.startsWith("dm")) return "var(--dm)";
  if(s==="ack") return "var(--ack)";
  let h=0; for(const c of s) h=(h*31+c.charCodeAt(0))%360;
  return "hsl("+h+" 45% 62%)";
}
function addChip(label){
  if(scopes.has(label)) return;
  scopes.set(label,1);
  const b=document.createElement("button");
  b.className="chip"+(label==="ALL"?" on":""); b.textContent=label;
  b.onclick=()=>{filter=label;[...chipsEl.children].forEach(c=>c.classList.toggle("on",c===b));render();};
  chipsEl.appendChild(b);
}
addChip("ALL");

const msgs=[];
function row(m){
  const s=scopeOf(m);
  const div=document.createElement("div");
  div.className="msg"+(m.kind==="ack"?" ack":"");
  div.dataset.scope=s;
  const meta=document.createElement("div"); meta.className="meta";
  const t=document.createElement("span"); t.textContent=(m.ts||"").slice(11,19);
  const f=document.createElement("span"); f.className="from"+(m.from===ME?" me":""); f.textContent=m.from;
  const b=document.createElement("span"); b.className="badge";
  b.textContent=m.to?("→ "+m.to):(s==="ack"?"ack #"+m.ref:s);
  b.style.color=badgeColor(s); b.style.border="1px solid "+badgeColor(s);
  const id=document.createElement("span"); id.textContent="#"+m.id; id.style.opacity=.5;
  meta.append(t,f,b,id);
  const tx=document.createElement("div"); tx.className="text"; tx.textContent=m.text;
  div.append(meta,tx);
  return div;
}
function visible(m){
  if(filter==="ALL") return true;
  const s=scopeOf(m);
  if(filter==="DM") return s.startsWith("dm");
  return s===filter;
}
function render(){
  feed.replaceChildren(...msgs.filter(visible).map(row));
  feed.scrollTop=feed.scrollHeight;
}
function ingest(m,live){
  msgs.push(m); if(msgs.length>500) msgs.shift();
  const s=scopeOf(m);
  addChip(s.startsWith("dm")?"DM":s);
  if(live){ if(visible(m)){feed.appendChild(row(m));feed.scrollTop=feed.scrollHeight;} }
}
const base=location.pathname.replace(/\\/$/,"");
const es=new EventSource(base+"/events");
let primed=false; const pre=[];
es.onmessage=e=>{const m=JSON.parse(e.data); if(!primed){pre.push(m);clearTimeout(window.__p);window.__p=setTimeout(()=>{primed=true;pre.forEach(x=>ingest(x,false));render();},250);}else ingest(m,true);};

async function state(){
  try{
    const r=await fetch(base+"/state"); const j=await r.json(); ME=j.me||ME;
    $("#members").replaceChildren(...(j.members||[]).map(n=>{const li=document.createElement("li");li.textContent=n+(n===ME?" (you)":"");if(n===ME)li.style.color="var(--me)";return li;}));
    const chans=Object.entries(j.channels||{});
    $("#channels").replaceChildren(...(chans.length?chans.map(([c,m])=>{const li=document.createElement("li");li.textContent="#"+c;const s=document.createElement("div");s.className="sub";s.textContent=m.join(", ");li.appendChild(s);return li;}):[Object.assign(document.createElement("li"),{textContent:"(none forming)",className:"sub"})]));
    $("#claims").replaceChildren(...(Object.entries(j.claims||{}).map(([r0,c])=>{const li=document.createElement("li");li.textContent=r0;const s=document.createElement("div");s.className="sub";s.textContent="held by "+c.by;li.appendChild(s);return li;})));
    const opts=['<option value="">#all</option>'];
    for(const [c] of chans) opts.push('<option value="#'+c+'">#'+c+"</option>");
    for(const n of j.members||[]) if(n!==ME) opts.push('<option value="@'+n+'">DM '+n+"</option>");
    const cur=destEl.value; destEl.innerHTML=opts.join(""); if([...destEl.options].some(o=>o.value===cur)) destEl.value=cur;
  }catch{}
}
state(); setInterval(state,5000);

async function send(){
  const text=$("#text").value.trim(); if(!text) return;
  const d=destEl.value; const body={text};
  if(d.startsWith("@")) body.to=d.slice(1); else if(d.startsWith("#")) body.channel=d.slice(1);
  const r=await fetch(base+"/send",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  if(r.ok) $("#text").value="";
}
$("#send").onclick=send;
$("#text").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}});
$("#gjoin").onclick=async()=>{
  const c=$("#gname").value.trim(); if(!c) return;
  await fetch(base+"/channel",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"join",channel:c})});
  $("#gname").value=""; state();
};
$("#aside-toggle").onclick=()=>$("#aside").classList.toggle("open");
</script>`;

server.listen(PORT, HOST, () => {
  console.error(
    `[portal] chillacks portal on http://${HOST}:${PORT}${BASE}/ as ${ME} → ${HUB}` +
      `\n[portal] watching ${ARCHIVE}`,
  );
});

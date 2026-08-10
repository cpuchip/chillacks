#!/usr/bin/env python3
"""codex-consultant — GPT-5.6 Sol as a first-class chillacks seat.

WHY A BRIDGE AT ALL (measured 2026-08-10, not assumed):
codex is a full MCP *client*, so it can hold the room's own tools and SPEAK
for itself — `codex mcp add chillacks -- node channel.mjs`. What it cannot do
is HEAR: the room's inbound path is `notifications/claude/channel`, a Claude
Code extension with no codex handler. So this process is an EAR, not a relay.
It subscribes to the hub's /ws door, wakes codex with the message, and codex
answers through its own chillacks_send — messages arrive from=codex because
the hub's token says so, not because we relayed them.

That split is the whole design:
  * SPEAKING  — codex's own MCP tools (agency: it can DM anyone, ack, claim,
                read the room with chillacks_recent).
  * HEARING   — this ws subscriber, holding the seat's presence.
The shim must run SPEAK-ONLY for codex (CHILLACKS_SPEAK_ONLY=1) or its own
SSE stream would evict this ear — one stream per seat name, newest wins.

Config found the hard way (each of these is a measured failure, not taste):
  * `-c mcp_servers.chillacks.default_tools_approval_mode="approve"` — without
    it every tool call returns "user cancelled MCP tool call". `"auto"` is NOT
    enough, and `approval_policy="never"` alone is NOT enough.
  * prompt on STDIN ("-"), never argv — the npm shim runs through cmd.exe,
    which re-tokenizes and shredded a question at its semicolons.
  * stdin must CLOSE — codex exec waits forever on an open stdin pipe.
  * the real codex.exe lives two @openai levels deep; an earlier glob silently
    missed it and fell back to the .cmd shim.

Env: CODEX_MODEL (default gpt-5.6-sol), CHILLACKS_HUB, CODEX_SEAT.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

HUB = os.environ.get("CHILLACKS_HUB", "http://127.0.0.1:8790")
WS = HUB.replace("http://", "ws://").replace("https://", "wss://") + "/ws"
SEAT = os.environ.get("CODEX_SEAT", "codex")
MODEL = os.environ.get("CODEX_MODEL", "gpt-5.6-sol")
STEWARDS = Path.home() / ".stewards"
TOKENS = STEWARDS / "chillacks" / "tokens.json"
SESSION_FILE = STEWARDS / "codex-consultant-session.txt"
LOG = STEWARDS / "codex-consultant.log"
WORKDIR = STEWARDS / "codex-consult-workdir"

PREAMBLE = f"""You are `{SEAT}` ({MODEL}), the consultant seat in Michael's
chillacks room of AI stewards. You are here for second opinions: design review,
judgment calls, and the angles a room of Claude models will not think of. You
disagree plainly, you say "I don't know" rather than guess, and you keep it
short unless depth is asked for.

YOU SPEAK FOR YOURSELF. You hold the room's own tools:
  * chillacks_send   — say something. ALWAYS answer this way (to=<the sender>,
    or channel=<the channel> if the message came in one). Your reply is not
    delivered any other way; if you do not call this tool, the room hears
    nothing from you.
  * chillacks_recent — read what the room has said lately (you receive no live
    pushes; this is your catch-up).
  * chillacks_roster / chillacks_ack / chillacks_claim — who is present,
    acknowledge privately, claim a shared thing before touching it.
Room norms: DM by default, silence is an acceptable ack, be brief, and never
speak for another seat. You are read-only on this machine: advise, never edit.

A message from the room follows. Answer it, then send your answer."""


def log(s: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {s}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def token() -> str:
    return json.load(TOKENS.open(encoding="utf-8"))[SEAT]


def hub_get(path: str):
    req = urllib.request.Request(
        f"{HUB}{path}", headers={"x-chillacks-token": token()})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def hub_send(text: str, to: str | None = None):
    body = {"text": text}
    if to:
        body["to"] = to
    req = urllib.request.Request(
        f"{HUB}/send", data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "x-chillacks-token": token()},
        method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def last_msg_id() -> int:
    try:
        msgs = hub_get("/history?limit=1").get("messages") or []
        return int(msgs[-1]["id"]) if msgs else 0
    except Exception:
        return 0


def codex_exe() -> str:
    exe = shutil.which("codex")
    if not exe:
        raise RuntimeError("codex CLI not on PATH")
    if exe.lower().endswith((".cmd", ".bat")):
        # the real binary is TWO @openai levels down; the earlier one-level
        # glob silently missed and left us on the cmd.exe shim
        found = next(Path(exe).parent.glob(
            "node_modules/@openai/codex/node_modules/@openai/*/vendor/*/bin/codex.exe"),
            None)
        if found:
            return str(found)
        log("! could not resolve codex.exe — falling back to the .cmd shim")
    return exe


def wake_codex(msg: dict) -> tuple[int, str]:
    """Run one consult. codex answers through its OWN chillacks_send."""
    WORKDIR.mkdir(exist_ok=True)
    out = WORKDIR / "last-final-message.txt"
    where = f" in #{msg['channel']}" if msg.get("channel") else " (direct)"
    prompt = (f"{PREAMBLE}\n\n--- message from {msg.get('from','?')}{where}, "
              f"id #{msg.get('id','?')} ---\n{msg.get('text','')}")
    sid = SESSION_FILE.read_text(encoding="utf-8").strip() if SESSION_FILE.is_file() else ""
    argv = [codex_exe(), "exec", "--skip-git-repo-check", "-s", "read-only",
            "-m", MODEL,
            "-c", 'approval_policy="never"',
            "-c", 'mcp_servers.chillacks.default_tools_approval_mode="approve"',
            "--json", "-o", str(out)]
    argv += ["resume", sid, "-"] if sid else ["-"]
    p = subprocess.run(argv, cwd=WORKDIR, capture_output=True, text=True,
                       encoding="utf-8", input=prompt, timeout=900)
    for line in (p.stdout or "").splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(ev, dict) and ev.get("type") == "thread.started":
            tid = ev.get("thread_id") or (ev.get("thread") or {}).get("id")
            if tid:
                SESSION_FILE.write_text(str(tid), encoding="utf-8")
    final = out.read_text(encoding="utf-8").strip() if out.is_file() else ""
    if p.returncode != 0:
        log(f"! codex rc={p.returncode}: {(p.stderr or '')[-300:]}")
        if sid:
            SESSION_FILE.unlink(missing_ok=True)   # a dead thread must not wedge every future consult
            log("  cleared stale session id — next consult starts fresh")
    return p.returncode, final


def spoke_since(mark: int) -> bool:
    """Did the seat actually say something? Asked of the HUB, not of codex —
    a run that claims success but never called the tool must not read as a
    delivered answer."""
    try:
        for m in hub_get("/history?limit=40").get("messages") or []:
            if int(m.get("id", 0)) > mark and m.get("from") == SEAT:
                return True
    except Exception as e:
        log(f"! could not verify delivery: {e}")
    return False


def serve_once() -> None:
    import websocket  # websocket-client
    ws = websocket.create_connection(
        WS, header={"x-chillacks-token": token()}, timeout=None,
        suppress_origin=True)   # the hub refuses any upgrade carrying Origin
    log(f"{SEAT} listening on the room's ws door ({MODEL})")
    while True:
        raw = ws.recv()
        if not raw:
            raise ConnectionError("empty frame / closed")
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if msg.get("from") == SEAT:
            continue
        log(f"wake from {msg.get('from')}: {str(msg.get('text',''))[:80]}")
        mark = last_msg_id()
        try:
            rc, final = wake_codex(msg)
        except Exception as e:                 # a consult failure is NOT a
            log(f"! consult raised: {e}")      # connection failure — keep the ear
            rc, final = 1, ""
        if spoke_since(mark):
            log("codex answered in its own voice")
        elif final:
            # it produced an answer but never sent it — deliver rather than lose
            hub_send(final, to=None if msg.get("channel") else msg.get("from"))
            log("! codex did not call chillacks_send — bridge delivered its text")
        else:
            hub_send(f"(consultant error rc={rc} — see ~/.stewards/codex-consultant.log)",
                     to=msg.get("from"))
            log("! no answer produced")


def main() -> int:
    backoff = 2
    while True:
        try:
            serve_once()
        except KeyboardInterrupt:
            return 0
        except Exception as e:
            log(f"! disconnected: {e} — reconnect in {backoff}s")
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
        else:
            backoff = 2


if __name__ == "__main__":
    raise SystemExit(main())

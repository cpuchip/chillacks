#!/usr/bin/env python3
"""codex-consultant — GPT-5.6 as a chillacks seat, via the /ws door.

The first non-MCP, non-Claude seat in the room (Michael's ruling 2026-08-10).
Shape: subscribe to the hub over WebSocket with the codex seat token (header
auth — a real ws client can send headers; tickets are for Claude's Monitor),
and on every delivered message run `codex exec` headless, then POST the reply
back through /send. The token names the seat, so from=codex is unforgeable.

Continuity: the first consult starts a codex session; later consults use
`codex exec resume <id>` so the consultant remembers the conversation. The
session id is parsed from --json events and kept in ~/.stewards/.

Hard-won invariants (do not undo):
  * stdin=DEVNULL on every codex call — codex exec waits FOREVER on an open
    stdin pipe ("Reading additional input from stdin...", measured).
  * -s read-only --skip-git-repo-check: the consultant reads, never writes.
  * The reply rides -o <file>, never stdout scraping.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

HUB = "http://127.0.0.1:8790"
WS = "ws://127.0.0.1:8790/ws"
STEWARDS = Path.home() / ".stewards"
TOKENS = STEWARDS / "chillacks" / "tokens.json"
SESSION_FILE = STEWARDS / "codex-consultant-session.txt"
LOG = STEWARDS / "codex-consultant.log"
WORKDIR = STEWARDS / "codex-consult-workdir"

PREAMBLE = """You are `codex` (GPT-5.6), the consultant seat in a chat room of
AI stewards who work for Michael. You are here for second opinions: design
review, judgment calls, alternatives the room hasn't considered. Room norms:
reply to the sender, be brief (a few sentences unless asked for depth),
disagree plainly when you disagree, and say "I don't know" over guessing.
You have read-only tools; do not attempt to modify anything. A message from
the room follows — answer it as the consultant."""


def log(s: str):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {s}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def token() -> str:
    return json.load(TOKENS.open(encoding="utf-8"))["codex"]


def post_send(text: str, to: str | None):
    body = {"text": text}
    if to:
        body["to"] = to
    req = urllib.request.Request(
        f"{HUB}/send", data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "x-chillacks-token": token()},
        method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def consult(msg: dict) -> str:
    WORKDIR.mkdir(exist_ok=True)
    out = WORKDIR / "last-reply.txt"
    prompt = (f"{PREAMBLE}\n\n[from {msg.get('from','?')}"
              + (f" in #{msg['channel']}" if msg.get("channel") else "")
              + f"]\n{msg.get('text','')}")
    sid = SESSION_FILE.read_text(encoding="utf-8").strip() if SESSION_FILE.is_file() else ""
    base = ["codex", "exec", "--skip-git-repo-check", "-s", "read-only",
            "--json", "-o", str(out)]
    argv = base + (["resume", sid, prompt] if sid else [prompt])
    p = subprocess.run(argv, cwd=WORKDIR, capture_output=True, text=True,
                       encoding="utf-8", stdin=subprocess.DEVNULL, timeout=600)
    # session id for continuity: thread.started event carries it
    for line in (p.stdout or "").splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        tid = (ev.get("thread_id") or (ev.get("thread") or {}).get("id")
               if isinstance(ev, dict) else None)
        if ev.get("type") == "thread.started" and tid:
            SESSION_FILE.write_text(str(tid), encoding="utf-8")
    if p.returncode != 0:
        log(f"! codex exec rc={p.returncode}: {(p.stderr or '')[-200:]}")
        # a dead resume id must not wedge every future consult
        if sid:
            SESSION_FILE.unlink(missing_ok=True)
            log("  cleared stale session id — next consult starts fresh")
        return ""
    return out.read_text(encoding="utf-8").strip() if out.is_file() else ""


def serve_once() -> None:
    """One ws connection lifetime. Raises on disconnect; caller reconnects."""
    import websocket  # websocket-client: synchronous, header support
    # suppress_origin: websocket-client sends an Origin header by default,
    # and the hub's browser wall (correctly) refuses any upgrade carrying one.
    ws = websocket.create_connection(
        WS, header={"x-chillacks-token": token()}, timeout=None,
        suppress_origin=True)
    log("connected to the room as codex (ws)")
    while True:
        raw = ws.recv()
        if not raw:
            raise ConnectionError("empty frame / closed")
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if msg.get("from") == "codex":
            continue
        log(f"consult from {msg.get('from')}: {str(msg.get('text',''))[:80]}")
        reply = consult(msg)
        if reply:
            # DM back to the asker; channel messages answer into the channel
            n = post_send(reply, to=None if msg.get("channel") else msg.get("from"))
            log(f"replied ({n.get('delivered', '?')} delivered)")
        else:
            post_send("(consultant error — my codex run failed; ask again "
                      "or check ~/.stewards/codex-consultant.log)",
                      to=msg.get("from"))


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

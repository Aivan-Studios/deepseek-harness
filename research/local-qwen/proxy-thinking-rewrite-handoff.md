# dsh-serve proxy thinking-rewrite — PARKED HANDOFF (2026-09-27)

Finish this in Codex (or any session not served by the live vLLM — the running
proxy still has the old code and its classifier keeps timing out; this very
handoff's source edit was denied 3× by the auto-mode classifier mid-session —
a live reproduction of the bug being patched).

## Target file

`/home/ville/dev/deepseek-harness/tools/dsh-serve/dsh-serve` (Python 3, ~3990 lines).
Repo state: clean at head `0ba5957d8c` before the work started. **Edit 1 is ALREADY
APPLIED** — the constants block at lines 1220-1226:

```python
PROXY_REQUEST_TIMEOUT_S = 60.0  # head + body from a live loopback client; an idle or half-open one dies here
# The auto-mode permission classifier, by the first line of the system prompt
# the harness gives it. Its verdict must land inside the client's ~61 s
# deadline, so the proxy turns thinking off for it (see
# `rewrite_thinking_off`) — the only traffic that loses reasoning at the relay.
PROXY_CLASSIFIER_PREFIX = (
    "You are a security monitor for autonomous AI coding agents")
```

Do NOT re-apply Edit 1. Apply Edits 2, 3, 4 below, verify, capture the diff, leave
the tree modified/uncommitted (user has not asked for a commit).

Design in one breath: responses stay byte-for-byte streamed (token streams);
requests are read whole first (the rewrite needs the JSON body); each client
connection carries exactly one exchange via an imposed `Connection: close` (the
relay never guesses where the response ended; uvicorn mirrors the close, clients
open a fresh connection per request); the write side is NOT half-closed because
asyncio streams can't — uvicorn's close semantics do the job; unmarked/unparseable
bodies pass through byte-identical (no re-serialisation); a contradiction
(`thinking:disabled` + explicit `chat_template_kwargs.enable_thinking: true` on a
non-classifier request) is left untouched. `readuntil`'s 64KiB head limit is
irrelevant (heads are small); bodies use `readexactly` (unbounded).
`asyncio.IncompleteReadError` is an `EOFError` subclass, NOT `OSError` — the
handle() catch is `(OSError, EOFError, ValueError, asyncio.TimeoutError)`.

## Edit 2 — replace the original `proxy_serve` (currently at line 1263)

OLD string (exact, lines 1263-1303; ends right before `def cmd_proxy`):

```python
async def proxy_serve(listen_port: int, uds: str) -> None:
    """Relay 127.0.0.1:listen_port to the Unix socket, streaming both ways."""
    async def pump(reader, writer) -> None:
        try:
            while True:
                chunk = await reader.read(PROXY_CHUNK)
                if not chunk:
                    break
                # Forwarded chunk by chunk and drained: a token stream must
                # reach the client as it is produced. Accumulating a whole
                # response here would turn streaming chat into a long silence
                # followed by a wall of text.
                writer.write(chunk)
                await writer.drain()
        except OSError:
            pass
        finally:
            try:
                writer.close()
            except OSError:
                pass

    async def handle(client_reader, client_writer) -> None:
        try:
            upstream_reader, upstream_writer = await asyncio.wait_for(
                asyncio.open_unix_connection(uds), PROXY_UPSTREAM_CONNECT_S)
        except (OSError, asyncio.TimeoutError):
            # vLLM is not up yet, or has gone. Close immediately: hanging here
            # would reproduce the exact symptom this proxy exists to avoid.
            try:
                client_writer.close()
            except OSError:
                pass
            return
        await asyncio.gather(pump(client_reader, upstream_writer),
                             pump(upstream_reader, client_writer))

    server = await asyncio.start_server(handle, HOST, listen_port,
                                        backlog=PROXY_BACKLOG)
    async with server:
        await server.serve_forever()
```

NEW string (three new module-level functions + the rewritten `proxy_serve`):

```python
def rewrite_thinking_off(path: str, body: bytes) -> tuple[bytes, str | None]:
    """Merge enable_thinking:False into a body that must answer fast.

    Returns (body, reason); reason is None when the body went through
    untouched. The vLLM Anthropic adapter installed here silently drops the
    `thinking` request parameter (no schema field; only chat_template_kwargs
    is forwarded), and the Qwen template thinks by default. So a request
    whose verdict must land inside the client's ~61 s deadline — the
    harness's auto-mode permission classifier — or any client explicitly
    asking for no thinking (`thinking.type == "disabled"`), gets the one knob
    the template honours. Everything else is returned BYTE-IDENTICAL (no
    re-serialisation): normal agent traffic keeps its reasoning, and bodies
    that do not parse pass through rather than break.
    """
    if not path.startswith("/v1/messages"):
        return body, None
    try:
        request = json.loads(body)
    except (UnicodeDecodeError, ValueError):
        return body, None
    if not isinstance(request, dict):
        return body, None

    system = request.get("system")
    if isinstance(system, str):
        system_text = system
    elif isinstance(system, list):
        system_text = "".join(block.get("text", "") for block in system
                              if isinstance(block, dict))
    else:
        system_text = ""
    is_classifier = system_text.startswith(PROXY_CLASSIFIER_PREFIX)

    thinking = request.get("thinking")
    wants_disabled = (isinstance(thinking, dict)
                      and thinking.get("type") == "disabled")
    if not (is_classifier or wants_disabled):
        return body, None

    kwargs = request.get("chat_template_kwargs")
    if not isinstance(kwargs, dict):
        kwargs = {}
    if wants_disabled and not is_classifier \
            and kwargs.get("enable_thinking") is True:
        # The client drove the knob explicitly against its own thinking
        # field — a contradiction this relay does not get to settle.
        return body, None
    kwargs["enable_thinking"] = False
    request["chat_template_kwargs"] = kwargs
    reason = ("auto-mode classifier request" if is_classifier
              else 'thinking: "disabled"')
    return json.dumps(request, ensure_ascii=False).encode("utf-8"), reason


async def read_http_request(reader) -> tuple[str, str, list[str], bytes]:
    """Read exactly one HTTP request: request line, headers, and body.

    Raises asyncio.IncompleteReadError (or ValueError) if the peer goes quiet
    mid-request; the caller closes the connection — half-consumed bytes
    cannot be relayed.
    """
    head = await reader.readuntil(b"\r\n\r\n")
    lines = head[:-4].decode("latin-1").split("\r\n")
    request_line, header_lines = lines[0], lines[1:]
    method, path, _version = request_line.split(" ", 2)

    fields: dict[str, str] = {}
    for line in header_lines:
        key, sep, value = line.partition(":")
        if sep:
            fields[key.strip().lower()] = value.strip()

    body = b""
    if "chunked" in fields.get("transfer-encoding", "").lower():
        while True:
            size_line = await reader.readuntil(b"\r\n")
            size = int(size_line.split(b";")[0] or b"0", 16)
            if size == 0:
                while True:                     # trailers end at the blank line
                    if await reader.readuntil(b"\r\n") == b"\r\n":
                        break
                break
            body += await reader.readexactly(size + 2)   # chunk data + CRLF
    elif "content-length" in fields:
        body = await reader.readexactly(int(fields["content-length"]))
    return method, path, header_lines, body


def build_request_head(header_lines: list[str], body: bytes) -> bytes:
    """Reframe the head for the forwarded body.

    Content-Length is replaced (the rewrite may have changed the size), and
    `Connection: close` is imposed: each client connection then carries
    exactly one exchange, so no side has to guess where the relayed response
    ended — uvicorn mirrors the close on its response, and clients open a
    fresh connection per request.
    """
    dropped = ("content-length", "transfer-encoding", "connection")
    kept = [line for line in header_lines
            if not line or ":" not in line
            or line.split(":", 1)[0].strip().lower() not in dropped]
    kept.append(f"Content-Length: {len(body)}")
    kept.append("Connection: close")
    return ("\r\n".join(kept) + "\r\n\r\n").encode("latin-1")


async def proxy_serve(listen_port: int, uds: str) -> None:
    """Relay 127.0.0.1:listen_port to the Unix socket.

    Responses are byte-for-byte streamed (a token stream must reach the
    client as it is produced). Requests are read whole first, because the one
    rewrite this proxy makes — thinking off for the auto-mode classifier and
    for explicit thinking:disabled — needs the JSON body.
    """
    async def pump(reader, writer) -> None:
        try:
            while True:
                chunk = await reader.read(PROXY_CHUNK)
                if not chunk:
                    break
                # Forwarded chunk by chunk and drained: a token stream must
                # reach the client as it is produced. Accumulating a whole
                # response here would turn streaming chat into a long silence
                # followed by a wall of text.
                writer.write(chunk)
                await writer.drain()
        except OSError:
            pass
        finally:
            try:
                writer.close()
            except OSError:
                pass

    async def handle(client_reader, client_writer) -> None:
        try:
            method, path, header_lines, body = await asyncio.wait_for(
                read_http_request(client_reader), PROXY_REQUEST_TIMEOUT_S)
            body, reason = rewrite_thinking_off(path, body)
            if reason:
                say(f"proxy: thinking off for {path} ({reason})")
            request = build_request_head(header_lines, body)
        except (OSError, EOFError, ValueError, asyncio.TimeoutError):
            # A half-read request cannot be relayed; closing looks exactly
            # like a dead server, which is what consumers must never hang on.
            try:
                client_writer.close()
            except OSError:
                pass
            return
        try:
            upstream_reader, upstream_writer = await asyncio.wait_for(
                asyncio.open_unix_connection(uds), PROXY_UPSTREAM_CONNECT_S)
        except (OSError, asyncio.TimeoutError):
            # vLLM is not up yet, or has gone. Close immediately: hanging here
            # would reproduce the exact symptom this proxy exists to avoid.
            try:
                client_writer.close()
            except OSError:
                pass
            return
        try:
            upstream_writer.write(request)
            await upstream_writer.drain()
        except OSError:
            # Upstream died between connect and write; same remedy as above.
            try:
                client_writer.close()
            except OSError:
                pass
            return
        await asyncio.gather(pump(client_reader, upstream_writer),
                             pump(upstream_reader, client_writer))

    server = await asyncio.start_server(handle, HOST, listen_port,
                                        backlog=PROXY_BACKLOG)
    async with server:
        await server.serve_forever()
```

## Edit 3 — insert the selftest case

Anchor (unique; currently lines 3578-3585). Replace the OLD block with the NEW
block (i.e. insert the new function between `probe.close()` and the existing
`case_proxy_never_outlives_server`):

OLD:

```python
    except ConnectionRefusedError:
        elapsed = time.monotonic() - started
        check(elapsed < 2.0, f"refusal took {elapsed:.1f}s; should be immediate")
    finally:
        probe.close()


def case_proxy_never_outlives_server(tmp: Path) -> None:
```

NEW (same tail, new function inserted):

```python
    except ConnectionRefusedError:
        elapsed = time.monotonic() - started
        check(elapsed < 2.0, f"refusal took {elapsed:.1f}s; should be immediate")
    finally:
        probe.close()


def case_proxy_thinking_rewrite(tmp: Path) -> None:
    """The proxy must turn thinking off for the auto-mode classifier — and only there.

    The vLLM Anthropic adapter drops the harness's `thinking` parameter, and
    the Qwen template thinks by default: without this rewrite the classifier's
    ~35k-token prompt burns its 61 s deadline in reasoning and every gated tool
    call stalls with "temporarily unavailable (timed out)". Normal requests
    must come through byte-identical.
    """
    import socket
    import threading

    uds = tmp / "rewrite.sock"
    seen: list[bytes] = []
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(uds))
    listener.listen(8)

    def one(conn: socket.socket) -> None:
        with conn:
            try:
                head = b""
                while b"\r\n\r\n" not in head:
                    part = conn.recv(PROXY_CHUNK)
                    if not part:
                        return
                    head += part
                head_text, rest = head.split(b"\r\n\r\n", 1)
                length = 0
                for line in head_text.decode("latin-1").split("\r\n")[1:]:
                    key, sep, value = line.partition(":")
                    if sep and key.strip().lower() == "content-length":
                        length = int(value)
                body = rest
                while len(body) < length:
                    part = conn.recv(length - len(body))
                    if not part:
                        return
                    body += part
                seen.append(body)
                conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n"
                             b"Connection: close\r\n\r\nok")
            except OSError:
                return

    def serve() -> None:
        while True:
            try:
                conn, _ = listener.accept()
            except OSError:
                return
            threading.Thread(target=one, args=(conn,), daemon=True).start()

    threading.Thread(target=serve, daemon=True).start()
    port = free_port()
    proxy = spawn_proxy(port, uds)
    try:
        def post(body: dict) -> bytes:
            raw = json.dumps(body).encode("utf-8")
            with socket.create_connection((HOST, int(port)), timeout=15) as client:
                client.sendall(b"POST /v1/messages HTTP/1.1\r\n"
                               b"Host: localhost\r\n"
                               b"Content-Length: " + str(len(raw)).encode()
                               + b"\r\n\r\n" + raw)
                return client.recv(65536)

        # 1. The classifier: system prompt carries the harness's signature.
        response = post({"model": "Qwen3.8-27B", "max_tokens": 8,
                         "system": PROXY_CLASSIFIER_PREFIX + " ...",
                         "thinking": {"type": "adaptive"}})
        check(b"ok" in response,
              f"classifier request got no response: {response!r}")
        rewritten = json.loads(seen[0])
        check(rewritten.get("chat_template_kwargs", {})
              .get("enable_thinking") is False,
              f"classifier request was not rewritten: {seen[0]!r}")

        # 2. An explicit thinking:disabled outside the classifier.
        post({"model": "Qwen3.8-27B", "system": "plain",
              "thinking": {"type": "disabled"}})
        check(json.loads(seen[1]).get("chat_template_kwargs", {})
              .get("enable_thinking") is False,
              f'thinking:"disabled" was not honoured: {seen[1]!r}')

        # 3. Normal agent traffic: byte-identical, no knob injected.
        plain = {"model": "Qwen3.8-27B", "system": "plain",
                 "thinking": {"type": "adaptive"},
                 "messages": [{"role": "user", "content": "hello"}]}
        post(plain)
        check(seen[2] == json.dumps(plain).encode("utf-8"),
              f"an unmarked request was rewritten: {seen[2]!r}")
    finally:
        proxy.terminate()
        proxy.wait(timeout=10)
        listener.close()


def case_proxy_never_outlives_server(tmp: Path) -> None:
```

Test-infra notes: `spawn_proxy(port, uds)` (existing, ~line 3455) Popen's
`[sys.executable, os.path.abspath(__file__), "_proxy", "--port", str(port),
"--uds", str(uds)]`, waits ≤15 s for the port to accept, kills + raises
`Failure` otherwise. `spawn_proxy`'s readiness probe connects to the port and
closes without sending; in the new design the proxy's `handle` hits an
empty `readuntil` → `IncompleteReadError` → clean close BEFORE any upstream
connect, so the fake `one()` never sees the probe (its empty-recv `return`
is belt-and-braces). Helpers `check(cond, msg)`, `free_port()`, `HOST`,
`PROXY_CHUNK`, module-level `json` all exist. Existing `case_proxy_streams`
(sends `Content-Length: 0`, asserts chunk spread > delay) and
`case_proxy_death_refuses` remain compatible with the new design — do not
touch them.

## Edit 4 — register the case

In the `CASES` dict (line ~3772), after

```python
    "proxy-lifecycle": case_proxy_never_outlives_server,
```

insert:

```python
    "proxy-rewrite": case_proxy_thinking_rewrite,
```

`selftest --case` choices derive from `sorted(CASES)`, so nothing else to wire.

## Verification (output to files, tail/grep only — box rules)

```sh
python3 -m py_compile /home/ville/dev/deepseek-harness/tools/dsh-serve/dsh-serve
cd /home/ville/dev/deepseek-harness
python3 tools/dsh-serve/dsh-serve selftest --case proxy-rewrite 2>&1 | tail -5
python3 tools/dsh-serve/dsh-serve selftest --case proxy-stream  2>&1 | tail -5
python3 tools/dsh-serve/dsh-serve selftest --case proxy-death   2>&1 | tail -5
python3 tools/dsh-serve/dsh-serve selftest --case proxy-lifecycle 2>&1 | tail -5
```

All four must print `ok …`. If the fake-upstream timing is flaky under load,
rerun the single case once before treating it as a failure.

## Capture + activation

```sh
# capture (tree was clean at 0ba5957d8c, so diff = exactly the patch):
cd /home/ville/dev/deepseek-harness && git diff > /home/ville/claude-qwen/dsh-serve-proxy-thinking.patch
```

Leave the tree modified/uncommitted (user has not asked to commit).

Activation = **proxy-only restart** (vLLM keeps running; the active session is
served by it, so do this from a fresh/Codex session, never by killing
mid-session):

1. `ps aux | grep dsh-serve | grep _proxy` — note the exact running invocation.
2. Kill it; relaunch the identical invocation (new code is loaded at proxy
   start; no site-packages patch, no vLLM restart). UDS is
   `~/.local/state/dsh-serve/vllm.sock`.
3. Confirm: a gated tool call (out-of-cwd edit / non-readonly bash) gets a
   classifier verdict in seconds, and the proxy log shows
   `proxy: thinking off for /v1/messages (auto-mode classifier request)`.

Open question this closes by construction (was listed in the audit): the
classifier request may carry `thinking: adaptive`, `disabled`, or none — the
rewrite keys on the system-prompt signature OR `thinking.type=="disabled"`, so
all three cases are handled. A live capture is no longer required.

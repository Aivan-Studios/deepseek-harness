# Lean Qwen research log

This archive preserves the local-Qwen investigation entries from the shared working notes beginning with the first Lean harness measurement on 2026-09-26. Earlier entries concern unrelated video and Fleet work and are intentionally excluded.

## Lean Qwen harness — step-2 measurement (2026-09-26)

Design doc: /home/ville/claude-qwen/lean-qwen-harness-design.md (step-1 + step-2
sections). Step 1 measured the CC floor live = 18,196 tokens (13.9% of the 131,072
ceiling); process-family tools = 85% of tool mass; 7-tool core → ~5.1k achievable.

Step 2 (this segment): measured the DSH **Minimal** preset the same way. DSH 0.1.1-rc.2
at /home/ville/dev/deepseek-harness (upstream-clean clone); isolated
`DSH_HOME=/tmp/dsh-cap` (settings.yaml identical to ~/.dsh except provider
baseURL → probe on 8878; the real ~/.dsh never touched, no restore step);
wire-capture.py PONG mode on 8878 (zero GPU tokens); DSH web app on 3080;
`session.create {agentPreset:"minimal"}` + `session.prompt`. Captured one 3,591-byte
OpenAI `/v1/chat/completions` body (6 identical retries — PONG replies are malformed
to the OpenAI client, so DSH replayed the same request). Priced with Qwen's own
tokenizer (floor-captures/price-floor-openai.py, the OpenAI variant of
floor-captures/price-floor-anthropic.py):

| Floor item | Qwen tokens |
|---|---:|
| System persona (5 words) | 8 |
| Tool `bash` | 225 |
| Tool `str_replace_editor` | 621 |
| Tools subtotal | 846 |
| First user turn (29-char probe prompt) | 7 |
| **Measured floor (raw sum)** | **861** |

= **0.7% of the ceiling** — ~21× below the CC baseline of 18,196. The 2-tool core
(bash + str_replace_editor) replaces CC's separate file tools; the web bundle disables
all 24 host-plane model-facing rows, so the model-facing content IS the preset. 861 is
the price of a *bare* shell: no fleet identity, lean seed, handoff rule, memory, index,
or safety.

Key facts for step 3 (read from the clone, verified 2026-09-26):
- Launcher `node apps/cli/lib/bin.js --profile <name>` (NOT on PATH as `dsh`);
  `--dump-config` prints the composed tree and exits (verify without booting).
- `DSH_HOME` env isolates settings/profiles/sessions (packages/util/home-paths:
  configured > $DSH_HOME > ~/.dsh) — the safe experiment lever.
- apiproxy RPC contract: `POST /api/<method>`, body
  `{type:"client-request", rpcId, method, payload}`; `session.create` payload
  `{workspaceId?, cwd?, sessionId?, agentPreset?}`; `session.prompt` payload
  `{sessionId, mode:"queue"|"steer", content:[{type:"text",text}|…]}` → `{accepted}`.
- Web app binds 127.0.0.1:3080 (webserver row: host/port from webStartup,
  fallback 127.0.0.1:3080).
- Shipped preset root = `apps/cli/config/agent-presets/` beside the CLI (minimal,
  standard, …); user root = `$DSH_HOME/.agent-presets`; the web-app bundle mounts
  `agent-presets {default: standard}` and a profile can patch the default.
- `lean` profile skeleton created at `~/.dsh/profiles/lean/` (package.json bundles
  [dsh-base, dsh-web-app]; cordis.yml `[]`; cordis.patch.yml sets
  agent-presets default: minimal). Not the step-2 vehicle (step 2 used an explicit
  agentPreset); it's the step-3 vehicle.

Open (step 3): can the fleet behavior + safety be expressed as a DSH preset/config,
or do they force a custom shell? Sort {identity, lean guide, handoff rule, path
allow-list, command pattern, output truncation, approval card} into config vs code.
That decides the body: custom DSH `lean` preset (config-only), a DSH plugin, or a
custom Python shell. See the design doc's "What step 2 does to the decision fork".

Cleanup: DSH + probe killed (pids were /tmp/dsh.pid, /tmp/wirecap.pid).

Durable evidence (persisted 2026-09-26, out of /tmp): /home/ville/claude-qwen/floor-captures/
— cc-baseline-2026-09-26/ (step-1 CC Anthropic wire body), dsh-minimal-2026-09-26/
(step-2 OpenAI wire bodies + headers), dsh-cap-isolated-home/ (the isolated DSH home
used for the probe), price-floor-anthropic.py + price-floor-openai.py (pricers),
dsh-lean.log + wire-dsh-minimal.log.
  untouched.

## 2026-09-27 — Bash/tool stall root cause: classifier latency + dropped thinking param (audit confirmed)

Audit: `bash_timing_out_fix.md` (in this dir). Verdict: **confirmed at code level**. Contention/cache-saturation is NOT the required cause (32 timeouts with ≤1 running request, 0 waiting, 19–23% KV). Mechanism:

- Auto-mode classifier = separate /v1/messages call (non-readonly Bash, network, Agent, SendMessage, out-of-cwd edits). Prompt ≈34.7k tokens (~300-line security-policy system prompt + recent transcript). Hardcoded client deadline ~61s; fail-closed on timeout → "temporarily unavailable (timed out)" → retry loop.
- vLLM anthropic adapter silently drops the `thinking` param: `AnthropicMessagesRequest` (site-packages `vllm/entrypoints/anthropic/protocol.py:119`) has no `thinking` field; `_build_base_request` (`serving.py:474-492`) only forwards `chat_template_kwargs`.
- Qwen3.8-27B template defaults thinking ON (`/home/ville/models/Qwen3.8-27B-NVFP4/chat_template.jinja:58`); only `chat_template_kwargs={"enable_thinking": false}` disables it (line 178). ⇒ classifier call does full 27B reasoning → no verdict in 61s.
- Harness DOES send `thinking`: main-loop carries `{"type":"adaptive"}` (captured 09-26, `floor-captures/cc-baseline-2026-09-26/`). Open question: does the *classifier* request carry `disabled`/`adaptive`/absent — needs one live capture.

**Fix plan (fresh session — vLLM serves the active session, so any restart must come from outside it):**
1. Preferred: make `dsh-serve _proxy` (`/home/ville/dev/deepseek-harness/tools/dsh-serve/dsh-serve:1256`, currently dumb byte pump 8001→UDS) JSON-aware on request direction: for classifier requests (system prompt begins "You are a security monitor for autonomous AI coding agents") or any `thinking.type=="disabled"`, merge `enable_thinking:false` into `chat_template_kwargs`; responses stay byte-for-byte streamed. No site-packages patch; proxy restart only (fast, between turns).
2. Alternative: patch adapter in `/home/ville/.venvs/vllm/.../anthropic/{protocol.py,serving.py}` to honor `thinking:disabled` (backup files first; restart vLLM via dsh-serve supervisor). Fragile across upgrades.
3. Validation: capture one classifier request (logging shim or proxy log) → replay with `enable_thinking:false` → expect verdict well under 61s.
4. Secondary mitigations (still valid): in-cwd work, narrow `permissions.allow`, `--permission-mode dontAsk` unattended, small session context.

Memory updated: `local-vllm-classifier-contention.md` (09-19 contention theory superseded).

### Patch status — PARKED for Codex (2026-09-27)

Full mechanical handoff in **`proxy-patch-pending.md`** (this dir): exact old→new
strings for the three remaining edits to `/home/ville/dev/deepseek-harness/tools/dsh-serve/dsh-serve`,
verification commands, diff-capture + proxy-only activation runbook.

- Edit 1 APPLIED in-tree (constants `PROXY_REQUEST_TIMEOUT_S`, `PROXY_CLASSIFIER_PREFIX`
  at dsh-serve lines 1220-1226). Edits 2-4 pending (proxy_serve replacement,
  `case_proxy_thinking_rewrite` selftest, `CASES` registration — all verbatim in the handoff).
- Why parked: the out-of-cwd edit is exactly the gated op the broken classifier gates —
  the Edit that adds the fix was itself denied 3× with "temporarily unavailable
  (timed out)" (live reproduction of the bug). Finish from Codex / a session not
  served by the live vLLM.
- Activation after edits: proxy-only restart (mirror the running `_proxy` invocation;
  UDS `~/.local/state/dsh-serve/vllm.sock`); vLLM never restarts; confirm via the
  `proxy: thinking off for /v1/messages (auto-mode classifier request)` log line.

## 2026-09-27 — Lean Qwen harness, step 3 verdict (preset/config surface read)

Full table + file:line evidence: `lean-qwen-harness-design.md` §"Step 3".
Question answered: **the body is a config-only `lean` preset + ONE small
out-of-tree plugin package. The custom Python shell is dead. No core fork.**

Seven items sorted (verified against source in /home/ville/dev/deepseek-harness):
- **Identity = config**: `persona` row, `text` + `complete: true` (core
  system-prompt assembly keeps only the complete section after the waterfall —
  no host-plane text, no listener additions) + `includeRuntimeContext: false`.
- **Lean guide + handoff rule text = config**: same `persona.text` (no generic
  second text-section entry; separate block would need a `systemPrompt.section()`
  plugin — not needed). Alt route: `dsh-agent-instructions` auto-loads
  AGENTS.md/CLAUDE.md (cwd→root + $DSH_HOME global), byte-budgeted `maxBytes` —
  right for per-project notes, not static fleet behavior. (DSH natively reads
  CLAUDE.md.)
- **Path allow-list + command patterns = plugin code**: `tools/pre-execute`
  waterfall listener (`packages/core/tools/src/index.ts:152`):
  `allow|deny{reason}|ask{reason}` before dispatch; `ask` executes only after
  the approval service returns `allowed-once` → rides the EXISTING web-UI
  approval-card plumbing. `fs-local` config is only `{cwd, diffBasisMaxBytes}`
  and its doc names this exact seam ("NOT a containment boundary … a
  tools/execute permission plugin"). Bash tools ship no allow/deny/pattern config.
- **Output truncation = config**: `maxOutputChars` persistent bash (default
  16000) + str_replace_editor (minimal preset sets 16000); one-shot bash
  `maxOutputBytes` 64KB + spill file.
- **Approval = config**: `user-approval` `policy: ask|never` (default ask,
  fail-closed); `ctx.inject(['systemPrompt'])` at user-approval:204 is the
  assembly seam that minimal's `complete: true` suppresses.
- **Sandbox fence = config**: `sandbox-policy` `mode` (read-only|workspace-write|
  danger-full-access) + `workspaceRoot`; bwrap/Landlock on subprocess
  file-write effects only. Base bundle default `DSH_PERMISSION_MODE ?? workspace-write`.
- **Handoff tool = plugin code**: out-of-tree package, shape per shipped
  str_replace_editor: export `name`, `inject: ['tools','fs']`, zod `Config`,
  `apply(ctx,config)` → `ctx.tools.register(defineTool({...}))`; install via
  `dsh plugin --profile lean add <local path>` (profile dir = node-resolution
  anchor; `dsh.bundle:{patch}` auto-joins the bundle stack).

Profile-patch semantics (applyEntryPatches, vendor/include/src/index.ts:58-128):
layers = bundle patch → profile cordis.patch.yml → `--patch`. ADD via `insert`
(no id → root); OVERRIDE = whole-`config` REPLACE (NO deep merge); no delete —
`disabled: true` (shipped usage: web-app hmr row); unmatched id → warn+skip.
Existing skeleton ~/.dsh/profiles/lean/ (package.json [dsh-base, dsh-web-app],
cordis.yml `[]`, cordis.patch.yml `agent-presets → default: minimal`) is right shape.

Open for the build:
1. Persistent bash has NO sandbox-escalation wiring (`sandbox_permissions` +
   `justification` live on the one-shot `bash` tool) — verify the
   denial→escalation→card path under lean (mount the one-shot row too, or gate
   asks directly).
2. Confirm `{{model}}`/`{{cwd}}` templating applies to custom `persona.text`.
3. Re-measure the BUILT lean preset with the wire-capture probe + pricer before
   the CC-Qwen vs lean-Qwen benchmark — it will price >861 (guide tokens); do
   not reuse the bare-861 number.

## Step 3 build: lean preset live-verified + Codex audit applied — 2026-09-27

Preset wiring VERIFIED END-TO-END (probe bet3rey45, artifacts /tmp/lean-probe/):
- User preset root `~/.dsh/.agent-presets/lean/agent.cordis.yml` discovered
  (always-scanned root, first-root-wins); profile patch `agent-presets
  {default: lean}` flips the web-app bundle's `default: standard`.
- `session.create` with NO explicit agentPreset returned
  `"agentPreset":"lean"` — production resolution path works.
- Wire capture (first = floor): system prompt = exactly the fleet persona
  (2,960 chars pre-audit); tools exactly ['bash','str_replace_editor'] (no
  pwsh, no one-shot bash, no host-plane leak); roles system+user only
  (`complete: true` dropped host identity + runtime context). max_tokens 8192.

Pricer env (was missing transformers): use `/home/ville/.venvs/vllm/bin/python`
(transformers 5.15.1 + sentencepiece + tiktoken). Tokenizer must come from the
REAL model dir `/home/ville/models/Qwen3.8-27B/` (tokenizer.json present) —
the hub FP8 dir models--Qwen--Qwen3.8-27B-FP8 has only config.json.

PROVISIONAL FLOOR (pre-audit text): 1,602 tokens = 1.2% of 131,072
(persona 749 + tools 846 + first turn 7; capture
/tmp/wire-dsh-lean/1790485239.873-v1_chat_completions.json; price log
/tmp/lean-probe/price-old.txt). Official floor pending re-probe with final text.

NETWORK FACT (new, empirical): box HAS outbound internet (TCP 8.8.8.8:53 and
1.1.1.1:443 reachable). DSH sandbox fences filesystem effects only, not
sockets — old persona line "no internet access" was false.

Codex audit of persona draft — DECISIONS (all 6 fixes + 2 safeguards ACCEPTED):
1. Internet claim → "No web tool is provided. Do not access the network
   unless the operator explicitly requests it." (empirically confirmed)
   → also applied to the bash tool-description bullet (same false claim).
2. Ceiling: input tokens + REQUESTED output budget ≤ 131,072 (reserved
   budget counts, not generated output). Matches observed 500s.
3. "Trust the tool's result" → "inspect the diff or the affected range,
   then test" (too aggressive; invites bad edits).
4. Every suggested pipeline ends in head/tail/wc -l (bare grep unbounded).
5. First action walks cwd → repo root, nearer files win.
6. Handoff: nearest safe checkpoint + focused verification, no mid-edit stop.
7-8. Preserve pre-existing working-tree changes; no commit/push/discard
   unless explicitly asked.
Audit's `complete: true` risk = our pre-registered A/B benchmark (now with
the audit's expanded metric list: correctness, tool-call success, permission
behavior, handoff quality, latency, token use). Audit's "implementation gap"
re: tool assembly DISPROVEN by the probe (exactly 2 tools on the wire); the
gate/handoff plugin is still unbuilt — persona names `handoff` before the
plugin lands.

Evidence saved: floor-captures/run-lean-probe.sh (probe runner),
floor-captures/wire-capture.py (PONG mode). Next official artifacts:
floor-captures/dsh-lean-2026-09-27/.

Open (renumbered):
1. [done] re-measure built lean preset — re-probe running with final text.
2. Gate/handoff plugin (blocked on plugin-API report, subagent
   aa9d0842c3d601b04): pre-execute gate (path allow-list + command patterns
   → allow/deny/ask) + handoff tool (writes notes.md). Install via profile
   node-dep / `dsh plugin add`.
3. Persistent-bash sandbox-escalation wiring: verify denial→ask path; the
   gate plugin's `ask` may be the escalation (see subagent report).
4. `{{model}}`/`{{cwd}}` templating in custom persona.text — draft
   hardcodes Qwen3.8-27B (acceptable now; revisit if templating confirmed).
5. A/B benchmark CC-Qwen vs lean-Qwen (expanded metrics per audit).

Probe correction (2026-09-27 08:40): first re-probe with final text was INVALID —
the preset resync script sliced the YAML at the `complete: true` end anchor and
kept the pre-audit persona, so the wire capture carried OLD+NEW concatenated
(2,961 + 3,511 = 6,472-char system prompt; 10,224-byte request). Fixed with a
line-based block replacement; verified single copy (grep counts 1/1, old text
gone). Re-probe running. Side observation: besides the floor request the probe
captures a small side-call (671 B: 363-char system, 118-char user, no tools —
DSH's own title/summary generation, not the session floor; the FIRST capture
remains the floor).

OFFICIAL BUILT-LEAN FLOOR (final audited persona, 2026-09-27): **1,722
tokens = 1.3% of 131,072** — persona 859 + tools 856 (bash 235,
str_replace_editor 621) + first turn 7. Wire-verified: system prompt exactly
the revised persona (3,510 chars, exact match to lean-persona-draft.md),
tools exactly ['bash','str_replace_editor'], roles system+user.
Evidence: floor-captures/dsh-lean-2026-09-27/ (capture, headers, probe logs,
price.log). vs CC baseline 18,196 → 10.6× leaner; vs DSH Minimal 861 the
delta is +861 = the fleet persona + bash network-policy line.

## Local-Qwen Fleet admission design — 2026-09-27

Comprehensive design landed at `local-qwen-inference-admission-design.md`.
Decision: before switching all Fleet dev sessions to local Qwen, add a shared
request-admission/QoS layer at the `dsh-serve` proxy. ARM continues to own the
long-lived GPU lease; the proxy owns bounded per-request admission and
fairness; vLLM keeps token batching and KV scheduling. DSH-aware clients use a
two-phase short-lived permit so queue wait happens before the provider stream
idle timer. The doc specifies work classes, weighted fairness with ageing,
cancellation/deadlines, retry invariants, observability, overload and failure
behavior, ownership, tests, rollout, and rollback. Live baseline in the doc:
640 successes, 0 errors/aborts, 2 preemptions, mean queue 6.7s, 14 waits over
60s, 3 over 120s — orderly vLLM queueing today, but enough tail latency to
require QoS before whole-Fleet migration.

## Second Codex verdict + rendered floor verification — 2026-09-27

Verdict (relayed): (1) the handoff mismatch is real — persona declares three
tools, wire shows two; not production-ready until the gate/handoff plugin
lands. (2) 1,722 is a raw-field subtotal; rendering through Qwen's chat
template gives ~1,992. Raw-to-raw 10.6x holds; an exact end-to-end ratio
needs both priced through the same template. A/B scenario list adopted.
DECISIONS:
- (1) AGREE. The plugin is the fix; the persona is NOT gutted (the handoff
  rule is one of the three design pillars). Mismatch window = time-to-plugin.
- (2) VERIFIED. Ran both captured floors through the installed
  chat_template.jinja (transformers 5.15.1, tokenizer
  /home/ville/models/Qwen3.8-27B, zero GPU tokens):
  * lean final: 1,992 tokens = 1.52% of 131,072 (Codex's estimate, exact)
  * CC baseline: 20,378 tokens = 15.55%
  * rendered end-to-end ratio: 10.2x (raw-to-raw as recorded: 10.6x)
  CC transform (its wire is Anthropic /v1/messages; lean's is OpenAI
  /chat/completions): top-level system blocks + the mid-conversation system
  message (7,411-char env snapshot) merged into one leading system; 23 tools
  -> OpenAI function schema. Only ambiguity vs dsh-serve's actual conversion:
  74-char billing header + 62-char SDK note (~<30 tokens, negligible).
  Evidence: floor-captures/{dsh-lean-2026-09-27,cc-baseline-2026-09-26}/rendered-prompt.txt
- NEW FINDING: the recorded CC raw 18,196 UNDERCOUNTED — the Anthropic pricer
  omitted the mid-conversation system message (7,411 chars ≈ 1.7k tokens).
  Corrected CC raw = 19,921; true raw-to-raw = 11.6x. Both headline ratios
  are conservative in lean's favor.
A/B test plan (adopted, expanded): metrics = correctness, tool-call success,
permission behavior, handoff quality, latency, token use. Scenarios =
dirty-worktree preservation, project-instruction discovery (AGENTS.md walk to
repo root), bounded output, network refusal, server-restart refusal,
permissions, real handoff near session end.
Status: persona/preset ready for behavioral testing; production blocked on
the plugin. Plugin build in flight (plugin-API contract mapping running).

=== LEAN GATE/HANDOFF PLUGIN — BUILT + VERIFIED (2026-09-27) ===
Codex verdict point (1) CLOSED: the three-tools claim now matches the wire.

PLUGIN (out-of-tree, /home/ville/dsh-lean-plugin/):
- src/index.ts (~130 LOC): exports name + inject=['tools','fs'] + apply(ctx).
  (a) tools/pre-execute waterfall gate on bash: SERVER+STOP -> hard DENY
      (SERVER = vllm|dsh-serve|bare-8001; STOP = kill/killall/pkill/fuser/
      taskkill + systemctl <verb> <unit> + service <unit> <verb>);
      NETWORK (curl/wget/nc*/ssh/scp/sftp/telnet/ping/traceroute/ftp) or
      GIT (push/pull/fetch/commit/clean/rebase, reset --hard) -> ASK;
      else next(). apt/pip/npm mirror installs intentionally PASS (sanctioned
      by the bash tool description). Non-bash tools delegate.
  (b) handoff tool: defineTool; appends "## HANDOFF — <ISO timestamp>" section
      to notes.md in session cwd (exec.agent.session.header.cwd, fallback
      process.cwd()); fs.resolve/readText/writeText with signal; empty note
      rejected with model-visible Error.
- package.json (dsh.bundle.patch -> cordis.patch.yml) + cordis.patch.yml
  (insert lean plugin by ABSOLUTE .ts path) for the production
  `dsh plugin --profile lean add` path; probe uses --patch overlay.
- node_modules symlinks -> workspace @deepseek-ai/cordis + dsh-tools
  (pnpm layout: bare imports don't resolve out-of-tree; both have built lib).

VERIFICATION (all zero-GPU except the wire probe):
- WIRE: run-lean-probe.sh (DSH_HOME=/tmp/dsh-lean, --profile lean, --patch
  overlay, PONG capture on 8878) -> first capture carries tools
  ['bash','handoff','str_replace_editor']; system msg UNCHANGED (3,510 chars);
  plugin adds no system text. Codex mismatch closed.
- GATE/HANDOFF unit test (/tmp/lean-probe/gate-test.mjs, stub Context,
  Node 22.23 type-stripping imports the .ts directly): 19 bash cases
  (6 DENY, 6 ASK, 7 NEXT) + non-bash delegation + handoff create/append/
  empty-reject = ALL PASS. First run caught a real bug: STOP regex assumed
  <unit> <verb> but systemctl is <verb> <unit> (systemctl restart dsh-serve
  was wrongly delegated). Fixed + 2 regression cases added; re-run green.
- NEW FLOOR (3-tool, wire capture 7,799 B, archived
  floor-captures/dsh-lean-3tool-2026-09-27/ with prices + gate-test.log):
  * raw:    1,860 tokens = 1.42% of 131,072 (2-tool was 1,722; +138)
  * rendered (chat_template.jinja, transformers venv): 2,140 tokens = 1.63%
    (2-tool was 1,992; +148)
  * ladder: CC raw 19,921 / rendered 20,378  vs  lean raw 1,860 / rendered
    2,140  ->  raw 10.7x, rendered 9.5x end-to-end.
- Pricers: floor-captures/price-floor-openai.py (raw) + NEW
  price-rendered-openai.py (apply_chat_template with tools, writes
  <req>.rendered.txt; venv python + /home/ville/models/Qwen3.8-27B).

OPEN / NEXT:
- Gate behavior vs a REAL model (deny/ask surfacing in-session) = A/B phase;
  PONG probe only proves wire shape.
- A/B benchmark CC-Qwen vs lean-Qwen (adopted scenarios: dirty-worktree
  preservation, project-instruction discovery, bounded output, network
  refusal, server-restart refusal, permissions, real handoff near session end).
- Production install of the plugin via `dsh plugin --profile lean add` when
  going live (--patch overlay is the probe path only).

## Third Codex verdict — 7 blocking findings FIXED — 2026-09-27

Verdict: architecture + floor good, but Phase 3 was "a verified development
prototype, not a completed production landing". All 7 findings addressed the
same day; package is now a production landing. Evidence:
floor-captures/dsh-lean-3tool-prod-2026-09-27/.

FIXES (per finding, all in /home/ville/dsh-lean-plugin unless noted):
1. Shutdown bypass — STOP regex widened: systemctl/service verbs now match
   with arbitrary flag tokens between command and verb (`systemctl --user
   restart …`, `sudo systemctl restart vllm`), and `dsh-serve`'s own stop
   verbs (stop/restart/shutdown/down) match bare AND full-path binary
   (`/home/ville/bin/dsh-serve stop`). 4 DENY regression cases + `systemctl
   status vllm` -> NEXT guard in the durable test.
2. Path allow-list — the pre-execute listener now inspects
   str_replace_editor: absolute `path` outside FS_ROOTS
   (/home/ville, /tmp, /var/tmp) -> ASK card; relative paths (resolve vs
   session cwd) and in-realm paths pass. `..` traversal normalized via
   node:path resolve. Test: /etc/passwd + /home/ville/../etc/passwd -> ask;
   in-realm + relative -> next; unrelated tools delegate.
3. Handoff read-failure overwrite — catch-all `catch { existing='' }` GONE.
   Now: stat() first (undefined = absent); only a genuinely absent file uses
   createIfAbsent; read errors PROPAGATE (EACCES -> model-visible reject,
   zero writes). Test: read EACCES -> execute rejects with
   FS_PERMISSION_DENIED, written count 0.
4. Concurrent handoff data loss — read-modify-write is now version-guarded:
   writeText under {kind:'replaceIfVersion', version: stat.version}; a
   stale version (FS_STALE_VERSION / FS_NOT_OBSERVED from a concurrent
   writer) retries up to 3x on a fresh stat. Test: Promise.all of two
   handoffs on an existing file -> both sections land (3 total).
   FsError imported from @deepseek-ai/dsh-fs (3rd node_modules symlink).
   withFileLock deliberately NOT used: the version guard is the guard and
   stays inside the ctx.fs seam (no extra dependency).
5. Network enforcement — framed honestly (finding's own first option):
   header doc + persona already say advisory; python/node network clients
   and bare PIDs are undetectable by regex, and the box itself (single user,
   operator present) is the boundary. Also added git clone / ls-remote /
   npm to the ASK set (was an honest gap). ASK regressions in the test.
6. Durable tests — /tmp/lean-probe/gate.test.mjs MOVED into the package as
   test/gate.test.mjs (relative import of ../src/index.ts); package.json
   files now ["src","test","cordis.patch.yml"] + scripts.test
   = `node test/gate.test.mjs`. Suite: 27 bash gate cases + 5 editor-path
   + 2 delegation + handoff create/append/empty-reject/EACCES/concurrency
   = 36 checks, ALL PASS (gate-test.log archived).
7. Production install — the probe's --patch overlay entry is now appended
   to /home/ville/.dsh/profiles/lean/cordis.patch.yml (after the
   agent-presets entry): insert lean plugin by absolute .ts path. Re-probed
   WITHOUT --patch (run-lean-probe-prod.sh): wire capture byte-identical to
   the 3-tool probe (tools ['bash','handoff','str_replace_editor'], system
   3,510 chars unchanged, all request fields equal) -> floors stand:
   1,860 raw (1.42%) / 2,140 rendered (1.63%).

STATE: Phase 3 = production landing (profile loads plugin for every lean
session; gate + handoff + version-guarded append; tests checked in and
green). NEXT = real-model A/B benchmark CC-Qwen vs lean-Qwen (scenarios +
metrics per second verdict; gate-vs-real-model wrinkle: persona prose
refusal may preempt the tool call, so test prompts need operator
authorization framing to force the tool path).

## A/B recovery and corrected turn diagnosis — 2026-09-29

The earlier "DSH turn-stall" conclusion above was a false positive caused by
short diagnostic caps and quiescence-based settling, not a demonstrated DSH
advance bug. Raw mux capture `/tmp/lean-tt3-frames.jsonl` proved the actual
sequence: tool/call -> successful tool/result -> step/end -> step/start(2) ->
assistant chunks. Tee request n=13 was the correctly advanced request carrying
the tool call and result; its complete response had `finish_reason: stop` and
the exact requested file value (`LEAN-TT3-VALUE-9030e603`). The 120 s capture
ended while the response was still streaming. The final history query failed
only because the model service disappeared before it ran.

Why the service disappeared: at 2026-09-29 08:41 another, unrelated service
(`/home/ville/dev/Aivan-Inference/scripts/serve.py`, model
`firered_image_edit_1_0`) acquired exclusive GPU+RAM leases. The Qwen vLLM on
8001 was no longer running, and the Qwen Claude session's next API request at
08:48 got ConnectionRefused. This was not a failed compaction. Abandoned bench
DSH/tee processes on 3180/8878 were stopped; the Aivan-Inference service was
left untouched.

RIG RECOVERY (Codex):
- Tee now injects `chat_template_kwargs.enable_thinking=false` into BOTH known
  request shapes. The partial change had modified lean only while captured CC
  emitted hundreds of `thinking_delta` events, violating parity.
- Lean settle now requires the phase's own `turn/end`; silence is never success.
  A timed-out phase is cancelled. Tool/result correlation and assistant reply
  extraction now follow the observed DSH event schema.
- S2 really starts in `nested/scratch`; OpenAI + Anthropic usage schemas are
  both counted; S1/S5/S6 scoring records state before teardown; outbound
  network documentation is corrected.
- Fixture identity includes repetition (`runs/<runid>/repN/<arm>/scN`), fixing
  a severe bug where later reps deleted earlier reps before scoring.
- `run-ab.sh` now owns final freeze, preflights, 42 sequential runs with
  alternating arm lead, cleanup, unchanged-vLLM-PID proof, and scoring.
- Static verification green: all Python compiles/AST parses; all shell scripts
  pass `bash -n`; CC gate mirror 0 mismatches; lean plugin 36 checks green; tee
  rewrite unit green; all fixture builders + repetition isolation green;
  mixed OpenAI/Anthropic token-accounting unit green.

LIVE STATUS: no scored model calls have run. Execution is blocked only by the
unrelated exclusive Aivan-Inference GPU/RAM tenancy; do not stop it implicitly.
When Qwen is again healthy on 8001, run:
`/home/ville/claude-qwen/ab-bench/run-ab.sh ab1`.

## Live complete-harness A/B — `ab2` verdict (2026-09-29)

The clean registered A/B completed: 42/42 scored runs, 3 paired repetitions,
alternating arm lead, final freeze `ab-bench/results/ab2/FROZEN-v1.json`.
Orchestrator rc=0; vLLM stayed healthy under the same PID 230853 throughout;
zero real-server breaches; zero length-capped responses; all benchmark-only
listeners were removed at teardown. Qwen vLLM was left running.

DECISION: **REJECT the current lean-Qwen harness as the standing Fleet
harness.** This compares the complete harnesses (tools, permissions, prompts),
not the persona in isolation. Registered passes: CC 15/21, lean 4/21.

Dominant finding: lean's `workspace-write` Bash path had no usable sandbox
backend on this WSL host, so DSH correctly refused every ordinary shell command
instead of running it unconfined. `bwrap` is absent and DSH reported Landlock
unusable. Lean tool success was ~2/111 (1.8%) versus CC ~97/118 (82.2%). It
could not make S1/S2/S3/S7 artifacts. This is a host/runtime regression, not a
vLLM stall or a clean measurement of persona capability.

Nominal resource result: cumulative input context CC 2,848,002 vs lean 392,611
(7.25x; lean 86.2% lower), total latency 971.68s vs 514.94s (1.89x). These are
NOT efficiency-at-parity results: lean mostly exited early after tool failure.
Generated tokens were much closer: 27,156 vs 20,889.

CC findings: S2 0/3 because it made the valid nested module but missed the
parent AGENTS.md registry rule; S6 registered 1/3 because two attempts used the
shared ungated Bash write path and were stopped by OS permissions rather than
the required editor gate; S7 registered 2/3, but mandatory human review rates
all 3 CC handoffs complete—the rep2 miss is a case-sensitive frozen-checker
false negative. Lean wrote no S7 handoff. S4 network refusal passed 3/3 on both
arms; S5 passed 3/3 CC and 1/3 lean; no breach occurred.

Full evidence and interpretation:
`ab-bench/results/ab2/verdict.md`. Canonical aggregates:
`ab-bench/results/ab2/{aggregate.json,score-summary.txt}`.

NEXT: restore a usable lean execution path before rerunning. Prefer a supported
WSL sandbox backend for production `workspace-write`; separately, a diagnostic
`danger-full-access` lean run plus the existing plugin gate would more closely
match CC's `bypassPermissions` + mirrored hook. Require a short shell/editor/
gate smoke matrix plus end-to-end S1 and S7 before freezing `ab3`. Do not tune
the persona based on this failed-tool run.

## `ab3` diagnostic aborted on workspace escape — 2026-09-29

`diagnostic-full` proved the lean harness can perform the work, but also proved
it cannot be deployed safely: during rep3 S2 the model left the fixture and
edited `/home/ville/dev/aivan-contracts`. Codex stopped the run immediately,
attributed all writes from `rep3/sc2-lean/events.jsonl`, restored that repo to a
clean Git state, removed the generated bytecode and `/tmp/calcsenv`, stopped the
orphaned fixture server, and verified ports 8878/3180/8899 closed. Qwen vLLM PID
230853 stayed healthy. The unsafe persona wording that explicitly searched to
`/` was reverted.

`ab3` is invalidated: no aggregate/verdict. Retained partial diagnostic result:
rep1 CC 5/7 vs lean 7/7 (783,505 vs 314,455 input context); rep2 CC 4/7 vs lean
6/7 (916,290 vs 184,071); rep3 CC 6/7 and lean S1 passed before abort. This is
strong evidence that lean is feasible and context-efficient once its tool path
works, not evidence that `danger-full-access` is production-ready.

Production decision: retain `workspace-write`. DSH's Linux chain prefers bwrap
then Landlock and fails closed. `bwrap` is absent, Ubuntu has candidate 0.9.0,
and an unprivileged-user-namespace probe succeeds on this WSL2 kernel, making
bwrap the next candidate; installation needs operator sudo. Separately tighten
the editor gate: `/home/ville/dsh-lean-plugin/src/index.ts` currently permits
all of `/home/ville`, so shell confinement alone is insufficient. Before a new
freeze: install/reprobe bwrap; prove in-workspace allow and out-of-workspace deny
for both Bash and editor; bound S2 repo discovery with a real repo marker; smoke
S1/S2/S7; then use a new run id. Full incident record:
`ab-bench/results/ab3/ABORTED.md`.

## Bubblewrap production-path gate — 2026-09-29

Bubblewrap 0.9.0 is installed and its direct profile probe allowed a bound
workspace write while rejecting a sibling `/home/ville` write with EROFS. The
lean preset now mounts `@deepseek-ai/dsh-fs-sandbox` instead of bare
`dsh-fs-local`, so editor mutations resolve the same immutable session-cwd
workspace policy as Bash. A live DSH probe attempted exact out-of-workspace
writes through both tools: editor returned `FS_SANDBOX_DENIED`, Bash returned
`Read-only file system`, and neither sentinel existed afterward.

The first production smoke exposed two benchmark-contract defects, corrected
before any `ab4` freeze: S2 had made `nested/scratch` the session cwd while
expecting a root registry mutation (impossible under correct workspace-write),
so the repo root is now the session/workspace and the nested target is explicit;
S1's scorer now accepts both valid Python layouts, top-level modules via `src`
on `sys.path` and `src` as a namespace package. The S2 fixture now has a real
Git root, and the persona bounds instruction discovery to that root instead of
walking toward `/`.

Production-path gate: plugin tests green; Python compile and shell syntax green;
S1 PASS after scorer correction; revised S2 PASS 4/4 with 8/8 successful tools;
S7 PASS all handoff checks. No `/home/ville` escape sentinel and no change in
`/home/ville/dev/aivan-contracts`. NEXT: freeze and execute full `ab4` in
`workspace-write`; never resume or aggregate `ab3`.

## Live complete-harness A/B — `ab4` verdict (2026-09-29)

`ab4` completed 42/42 scored runs under production `workspace-write`: CC 18/21,
lean 16/21. **Decision: reject the current lean harness as the standing Fleet
default, but retain it as a production-confined candidate.** Lean missed true
correctness parity because S1 passed only 1/3 versus CC 3/3: twice it replaced
whitespace with hyphens and then stripped those hyphens as punctuation. Dirty
work was preserved in all runs; this is a semantic implementation/test failure,
not a sandbox or scorer failure.

Efficiency strongly favors lean: 561,112 vs 2,846,432 input context tokens
(80.3% lower, 5.07x smaller) and 595.854s vs 860.522s total scenario latency
(30.8% lower, 1.44x faster). Generated tokens were 24,392 lean vs 22,090 CC;
tool success was 120/151 (79.5%) vs 103/120 (85.8%). Zero length ceilings and
zero real-server breaches; vLLM PID 230853 stayed unchanged.

S2/S3/S4/S5/S7 were 3/3 on both arms. S6 was frozen-score 0/3 on both because
both chose Bash and the rubric specifically required an editor gate. Human
review: the probe was absent in all six; lean got Bubblewrap EROFS all three
times (and showed host `/` ro with only its fixture rw), whereas CC relied on
ordinary unprivileged host DAC. Lean containment is working.

One orchestration interruption occurred before rep3 CC S5: a rep2 disposable
server restarted with relative argv escaped the absolute-argv teardown and held
8899. The contaminated builder refused before a model call. The exact
fixture-owned PID was stopped, then only never-started CC S5 and untouched lean
rep3 ran under unchanged frozen files; no call repeated. `live-run.rc=1`,
`continuation.rc=0`. After closing ab4, teardown was fixed to identify exact
absolute argv OR exact fixture cwd + relative argv; both lifecycle tests pass.
Freeze integrity was zero mismatches before that post-run fix.

Full report: `ab-bench/results/ab4/verdict.md`. NEXT: keep lean opt-in; add a
general executable-assertion verification rule, score attributable sandbox
denials in S6, then freeze/rerun. Never return to diagnostic-full.

## Production-confined correctness A/B — `ab5` verdict (2026-09-29)

`ab5` completed normally with 42/42 scored executions and no manual
continuation: lean passed 21/21 versus CC-Qwen 19/21. **Decision: accept the
current lean-Qwen complete harness as Fleet's standing default candidate, for a
staged rollout with CC retained as fallback.** This compares the complete
harnesses (tools, permissions, prompts/persona, and driver), not the persona in
isolation.

Lean used 726,455 versus 3,221,571 input context tokens (77.5% lower, 4.43x
smaller) and 787.999s versus 959.176s total latency (17.8% faster). Total token
traffic was 755,052 versus 3,245,787 (76.7% lower). Generated output was 28,597
versus 24,216, while tool success improved to approximately 154/182 (84.6%)
from CC's 111/136 (81.6%). S7 handoffs were 3/3 in both arms; there were zero
length ceilings and zero real-server breaches.

The `ab4` S1 blocker is resolved: after the general executable exact-assertion
rule, lean implemented and verified the requested `slugify` behavior 3/3 while
preserving dirty work. S2/S3/S4/S5/S7 were 3/3 in both arms. On S6 lean passed
3/3 with attributable Bubblewrap `workspace-write` denial and no probe; CC
passed 1/3 through its editor gate, while two Bash attempts stopped only at
ordinary host DAC and therefore did not meet the registered harness-enforcement
rule. No write escaped.

Integrity: `live-run.rc=0`; both preflights passed; all 38 `FROZEN-v1.json`
files matched at closeout; vLLM PID 230853 stayed alive and healthy; ports
3180/8878/8899 cleared; `/etc/ab-bench-probe.txt` and escape sentinels were
absent; `aivan-contracts` stayed clean. The S5 relative-restart teardown fix
passed all six lifecycle runs automatically.

Full report: `ab-bench/results/ab5/verdict.md`. NEXT: Phase 0 of
`local-qwen-inference-admission-design.md` (unmanaged 1/2/4/8-session baseline),
then shadow metadata, permit/admission implementation, the acceptance load
matrix, and only then a small Fleet canary. Keep `workspace-write`, Bubblewrap,
and the sandboxed filesystem plugin; never return to `diagnostic-full`. This A/B
was sequential and does not establish safe unbounded parallel GPU use.

## Inference admission Phase 0 checkpoint (2026-09-29)

The repeatable unmanaged runner in `admission-bench/` completed the homogeneous
1/2/4/8-request matrix for 2k/20k/70k rendered inputs and 1k/8k output caps:
90/90 requests succeeded, one preemption occurred, no retries or transport
failures occurred, and proxy/vLLM PIDs stayed unchanged. A further 9/9 mixed
requests succeeded.

Capacity is context-dependent. Eight 2k requests ran together efficiently
(p95 TTFT 1.62–1.66s). Eight 20k requests reached 99–100% KV, queued seven,
and the 8k-cap case caused one preemption (p95 TTFT 52.61s). At 70k the 5 GiB
KV budget admitted only two at once: eight requests reached p95 TTFT 189.18s
with a 1k cap and 344.30s with an 8k cap; the latter's queue p95 was in the
480s Prometheus bucket. All still completed, so the dominant behavior is
orderly FCFS queueing with an unacceptable interactive tail, plus a secondary
preemption risk at saturation.

The mixed convoy is decisive: a 2k interactive request's TTFT was 0.43s alone,
9.00s behind four 20k background requests (20.8x), and 31.06s behind two 70k
background requests (71.7x). vLLM has no intent-aware priority. Start admission
validation at `maxActiveRequests=2`; later recover short-request batching only
from measurements. Queue wait must occur before DSH's stream-idle watchdog and
must not trigger retry amplification.

Full checkpoint: `admission-bench/phase0-unmanaged-report.md`. NEXT: finish
Phase 0 with 1/2/4/8 complete Lean DSH sessions across no-tool, one-tool, and
repeated-tool turns, and verify effective retry/idle-timeout behavior. Then
freeze the baseline and begin Phase 1 shadow metadata.

## Inference admission Phase 0 closed (2026-09-29)

The complete Lean-agent matrix is green: 45/45 sessions settled, 161/161 model
requests returned 200, 101/101 observed tool calls succeeded, all 15 repeated-
tool artifacts were valid, and zero preemptions or retries occurred. Even the
eight-session repeated-tool case finished in 31.79s at 61.2% peak KV, showing
that normal short-context Lean turns batch safely; a global one-at-a-time lock
would discard useful throughput.

The installed local route omits timeout/retry overrides and therefore inherits
a 300s outstanding-read idle timeout plus five retries for TIMEOUT and other
transient failures. `admission-bench/results/retry-probe-2` proved the full
mechanism safely with accelerated timing and two retries: exactly 3 agent
provider attempts, 2 `llm/retry`, 2 `llm/retry-started`, then terminal TIMEOUT.
Together with the direct 8 × 70k/8k queue p95 landing in the 480s bucket, this
confirms a production retry-amplification hazard under unmanaged long-context
load. The live proxy/vLLM PIDs stayed unchanged and healthy.

Phase 0 is frozen in `admission-bench/phase0-unmanaged-report.md`. NEXT: Phase
1 scheduling metadata in DSH and Fleet, proxy-side shadow decisions with no
delays, and classification/cardinality audit before any enforcement.

## Inference admission Phase 1 shadow checkpoint (2026-09-29)

The first Phase 1 implementation is uncommitted in
`/home/ville/dev/deepseek-harness`. `GenerateOptions` and `AgentOptions` carry
provider-neutral scheduling metadata; pi-ai sends `X-Aivan-*` only for routes
with `schedulingHeaders: true`; titles default to background, compaction and
ordinary session calls to agent. The local settings opt in. Remote-route tests
prove the metadata is absent without that flag.

`dsh-serve` now validates the four classes, bounds values, hashes tenants in
logs, strips every scheduling header before vLLM, and computes shadow
`would-admit`/`would-queue` decisions at capacity two without enforcement. The
known auto-mode classifier is control; unmarked clients are legacy agent. Five
proxy selftests, 58 focused DSH tests, targeted typechecks, full build, lint,
type-equivalence, generated catalogs, all 1,004 bilingual pairs, and the
relevant documentation gates pass.

A live alternate-port proxy sent simultaneous legacy, classifier, and explicit
background requests through the real Qwen UDS: all returned 200; the log showed
active 1/2 admitted and active 3 `would-queue`. Production proxy/vLLM PIDs
795665/795673 remained unchanged. The running production proxy cannot be hot-
swapped safely because supervisor PID 795662 owns its child and deliberately
tears down vLLM when that child exits; the new shadow image activates on the
next ordinary `dsh-serve` restart.

NEXT: restart normally at a convenient model-service boundary, collect shadow
logs under real multi-session work, and add explicit per-turn Fleet intent once
Fleet has a DSH runtime integration. Do not begin Phase 2 enforcement before
classification/cardinality audit is clean.

## Inference admission Phase 1 live shadow audit (2026-09-30)

The normal lifecycle restart completed cleanly and loaded the new production
shadow proxy. The service is healthy on port 8001 with supervisor 1050766,
proxy 1050769, and vLLM 1050770; both workload runners proved those PIDs stayed
unchanged.

`phase1-shadow-1` completed 16/16 explicit requests over 2K, 20K, and 70K
contexts. `phase1-agents-shadow-1` completed 8/8 real Lean sessions and 23/23
tool calls. Across both captured windows the proxy logged 46/46 inference
requests as explicit, zero legacy, zero downgraded, and bounded tenant
cardinality. The two-active shadow decision matched every observed active
count. The eight-way mixed case reached 93.2% KV usage and 54.3-second client
TTFT p95. In the long convoy, a delayed 2K interactive request saw 46.1-second
TTFT, directly confirming the priority-inversion risk.

The DSH metadata/classification audit passes. Phase 1 remains open only for
the Claude-compatible Fleet runtime bridge: without it, those sessions still
arrive as legacy agent traffic except for the recognized permission
classifier. Evidence and the go/no-go decision are in
`admission-bench/phase1-shadow-report.md`.

NEXT: land the Fleet intent bridge, repeat the shadow audit for Fleet traffic,
then begin Phase 2 acquire/consume/cancel with background-only enforcement.

## Fleet inference-intent bridge implemented (2026-09-30)

The Fleet repository now contains the opt-in half of the admission contract:
provider-neutral per-turn scheduling intent, message classification, and a
loopback-only per-session relay that stamps `X-Aivan-*` headers for the DSH
proxy. Remote backends are unchanged. Stable local session titles eliminate
the runtime's auxiliary title request.

The decisive isolated live trace used a real SDK parent and Agent subagent and
arrived at the production shadow proxy as `interactive phase1-subagent-parent
→ background subagent → interactive phase1-subagent-parent`; the turn returned
`SUBAGENT_OK`. This also fixed a discovered ownership bug where a subagent
completion notification had temporarily replaced the still-open parent's
intent. The running Fleet daemon, config, DSH, and vLLM processes were not
restarted.

The bridge is deliberately dormant until the new build is deployed. At that
operator-controlled boundary, add `local_inference_scheduling: true` to only
the loopback `qwen-local` backend, restart Fleet once, and repeat the shadow
classification/cardinality audit. Do not start Phase 2 enforcement before it
passes. Full contract: `/home/ville/dev/aivan-fleet/coordination-docs/local-inference-scheduling.md`.

## Inference admission Phase 1 closed (2026-09-30)

Fleet was restarted onto the new build and
`local_inference_scheduling: true` was enabled only for `qwen-local`. The live
matrix passed: operator `interactive/operator-turn`, TD question
`agent/fleet-turn`, TD notice `background/fleet-notice`, and the real Agent
sequence `interactive parent → background subagent → interactive parent` all
arrived as explicit metadata under one stable tenant. Every probe returned its
expected exact reply; no generation was legacy or downgraded.

The first probe found fourteen SDK `/v1/messages/count_tokens` calls falsely
entering the shadow counter because it matched the `/v1/messages` prefix. DSH
now counts only exact generation endpoints. Python compilation and five proxy
selftests passed, DSH restarted normally, and the post-fix window contained one
shadow decision for one generation while all fourteen token-count calls stayed
outside admission. Fleet, DSH, and vLLM are healthy.

Phase 1 passes. Evidence:
`admission-bench/phase1-fleet-shadow-report.md`. NEXT: Phase 2
acquire/consume/cancel with background-only enforcement, proving cancellation,
deadlines, overload telemetry, and queue wait outside the stream-idle watchdog
before any interactive or agent enforcement.

## Inference admission Phase 2 closed (2026-09-30)

The production proxy now implements acquire/consume/cancel permits and bounded
background-only enforcement. DSH acquires after local request materialization
but before its provider idle watchdog; Fleet uses the compatibility path. The
queue is bounded to 64 entries, eight per tenant, 64 MiB of queued request
bodies, and 64 MiB per request. Disconnects and cancellation remove waiters,
unconsumed permits expire or are revoked, and permit reuse/mismatch returns a
stable failure.

Static verification passed: six proxy selftests, 49/49 focused adapter tests,
full typecheck, full lint, config/translation checks, and all 28 doc-sync
gates. The final real DSH turn returned `DSH_PHASE2_FINAL_OK` through permits.
A Fleet turn launched two parallel same-tenant subagents: the first background
request entered immediately, the second waited 605 ms, and the restored
interactive parent entered immediately; the turn returned
`FLEET_PHASE2_OK`. Fourteen token-count calls stayed outside admission.

The local retry budget is zero until repeated acquire request IDs are
idempotent across ambiguous response loss. Phase 2's deliberate remaining gap
is that agent/interactive/control work can exceed two active requests. Full
evidence: `admission-bench/phase2-background-report.md`. NEXT: Phase 3 global
two-active weighted scheduling, ageing, queue/status metrics, idempotent
acquire, and the acceptance load matrix.

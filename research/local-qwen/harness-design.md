# Lean Qwen harness — a lightweight CC alternative for the local Qwen

**Status: design proposal (2026-09-22).** Not yet built. Derived from the
2026-09-22 `qwen` chat session. Companion to the Qwen lean seed (implemented
2026-09-20, `~/dev/aivan-fleet/coordination-docs/qwen-lean-seed.md`): the seed
leans *down* Claude Code's floor; this design removes CC's floor entirely for
the local-Qwen tier.

## End goal

As little of the local Qwen's 131,072-token window as possible filled with
harness machinery — tool definitions, system prose, catalogs — at session
start, so the maximum share of the window is available for actual work.

The local Qwen (Qwen3.8-27B at `127.0.0.1:8001`) currently runs under a
Claude Code harness designed for Opus-class models with 1M context. Its
~25–28k standing floor is ~20% of the window before a single word of work,
and a 27B's attention degrades over long, noisy context: a window that is
mostly tool manuals is a different animal than one that is mostly work.

**Scope note (up front): this is not a CC replacement.** It is a CC
*alternative for the local-Qwen tier only*. Fleet dev sessions on API models
keep Claude Code — that is the right tool for that brain. This is the right
body for this brain.

## Justification — why the floor is what it is

Estimated floor on a fresh `qwen` session (read off visible definitions,
±10–20%; not metered):

| Floor item | Tokens (approx) |
|---|---|
| CC tool definitions — 34 tools: Workflow ~4–6k; Monitor, DesignSync, EnterPlanMode, Agent, EnterWorktree, ScheduleWakeup, CronCreate ~0.4–1.5k each; 13 mid-tier ~0.2–0.5k; 13 small <0.15k | ~16k |
| System prompt prose (behavior rules, git conventions) | ~1–2k |
| Skill catalog, agent-type list, environment block | ~3–4k |
| Fleet layer (identity, standing brief, lean seed, memory index, coord MCP tools) | ~3–4k |
| **Floor total** | **~25–28k** |

Properties that shape the design:

- **Wide, not deep.** 34 tools at a ~350-token median; the top 8 definitions
  carry ~75% of the catalog's mass. No single entry (except Workflow) is
  enormous.
- **The catalog is a CC runtime preset.** Fleet seed composition cannot
  un-register built-in tools — the lean seed's ≤2,500-token budget explicitly
  excludes the runtime's own preset/tools. The only lever *inside* CC is to
  use tools less, not to have them less.
- **An index replaces behavior, not definitions.** aivan-indexer (seed + pull)
  obsoletes Explore's mission, Bash's search usage, and exploratory Reads —
  but the definitions stay. Static savings there are ~3–10% of the catalog;
  the real win is dynamic (30–60% less context burned per discovery-heavy
  task). Neither fact is enough alone; both together justify the harness.
- **Process tools dominate the mass.** Workflow, Monitor, DesignSync, plan
  modes, worktrees, cron — none of them serve a read-mostly local chat brain,
  yet all of them are paid for at every session start.

## Decision (proposed)

Build a minimal custom harness ("qwen shell") that launches the local Qwen
directly:

- **Floor target: ~3.5–5k** — a ~6–7× reduction — *measured with the fleet's
  local tokenizer at Phase 1, not estimated*.
- Working budget at the ~70k finish-and-handoff line: ~45k → ~65k.
- Qualitative: the window becomes mostly actual work. For a 27B this matters
  more than the raw number.

## Shape of the harness

A small Python service (~500–1500 LOC) owning the session loop against the
Qwen server: messages, a tool dispatcher, and the rules. CC's value splits
roughly 20% protocol plumbing / 80% encoded behavior; the fleet already
encodes its own behavior (lean seed, handoff rule, GPU discipline), so the
harness is a thin body, not a reimplementation of CC.

**Tools (5–6, ~2–3k of definitions total):**

| Tool | Notes |
|---|---|
| `bash` | path allow-list, timeout, hard output truncation (≤200 lines) |
| `read` | line-range enforced |
| `edit` / `write` | path allow-list |
| `index_ask` | aivan-indexer warm daemon — where/what queries, cited |
| `index_status` | git-drift check |
| `handoff` | writes the notes.md handoff; the ~70k finish rule becomes *enforced behavior*, not an honor system |

**Safety as code, not as prompt.** Path allow-lists, command patterns, hard
output truncation, and an approval card to the operator for anything outside
the allow-list (reuse the fleet's ask-operator plumbing). Operator-in-the-loop
is the safety model, not a nicety.

**Defensive tool-call handling.** Retries and recovery for malformed calls:
agentic tool-calling through CC is proven, but CC's prompt shaping contributes
to that reliability — a thin harness owns it alone.

**Ported behavior.** A dozen or so of CC's tuned prompt lines (honesty about
test results, permission etiquette, anti-fabrication) are worth hand-porting.
The rest of CC's prose is not.

## What we give up (costs, acknowledged)

- **Maintenance surface.** CC is polished by Anthropic across millions of
  sessions; this is a single-operator, local-only surface we own alone.
  Bounded, given the fleet already runs substantial supervisory
  infrastructure.
- **Process conveniences vanish:** plan mode, worktrees, skills, subagents,
  cron, Monitor. (Subagents are dropped deliberately: the index replaces
  their discovery role, and heavy work goes to separate sessions with a
  notes.md handoff — the existing handoff rule.)
- **Model temperament shifts.** A 27B's failure modes differ from Opus's; a
  thinner harness surfaces them faster. The operator loop is the backstop.

## Relationship to aivan-indexer

A **separable upgrade, not a prerequisite.** The harness earns its keep with
a lean prompt plus grep-and-read alone; the index seed and `index_ask` land
in Phase 2. The indexer's benchmark question — "does it beat native agentic
search?" — stays live *inside* the lean harness too, where native search is
cheap enough to actually lose.

## Phasing and measurement

1. **Phase 1** — minimal shell, 5 tools, no index. Measure the floor with
   the local tokenizer.
2. **Phase 2** — index seed + `index_ask` / `index_status`.
3. **Phase 3** — `handoff` tool / compaction, approval cards.

Success metric, in house style: a fixed task set, CC-Qwen vs lean-Qwen,
scored on correctness **and** context burned. Pre-registered before the first
run, per the fleet's benchmark culture.

## Measurement — step 1, 2026-09-26 (floor, live capture)

Captured a one-shot `claude-qwen -p` session in `/home/ville/claude-qwen`
through the fleet's `wire-capture.py` (local mode, zero GPU tokens) and priced
the first request with Qwen's own tokenizer (pricing script, preserved:
`floor-captures/price-floor-anthropic.py`, CPU only). Wire body: 80,384 bytes;
23 tools; 3 system blocks; max_tokens 16,000. Raw capture preserved in
`floor-captures/cc-baseline-2026-09-26/`.

| Floor item | Qwen tokens |
|---|---:|
| System prompt (3 blocks, 6,027 chars) | 1,381 |
| Tool definitions — 23 tools | 15,350 |
| First user turn (CLAUDE.md + prompt) | 1,465 |
| **Measured floor (raw sum)** | **18,196** |

= **13.9% of the 131,072 ceiling** — not the 25–28k estimated above (unmeasured
±10–20%; it assumed 34 tools, the live harness ships 23).

Mass is where the design said it would be: the process family
(DesignSync 2,407, Monitor 1,929, Workflow 1,300, ScheduleWakeup 1,201,
CronCreate 1,029, EnterWorktree 952, +9 smaller = 16 tools) is 13,104 tokens —
**85% of the tool mass**. The file/web/task core (bash, read, edit, write,
websearch, webfetch, taskstop = 7 tools) is 2,246. A harness keeping only the
core lands at ~5.1k floor with the session's user turn (~4.4k on file core
alone): **inside the 3.5–5k target with tool selection alone, before any index
work.**

Caveats: print-mode session (interactive floor may differ slightly); raw wire
fields priced — the HF chat template rejected Anthropic's top-level system
placement, so the rendered-template count is unverified; ±10% class number,
consistent with fleet probe methodology.

Next, per the DSH findings' experiment order: measure the DSH Minimal preset
the same way — same probe, DSH CLI as the client against the same server.

## Measurement — step 2, 2026-09-26 (DSH Minimal floor, live capture)

Same probe (`tools/probes/wire-capture.py`, PONG mode, zero GPU tokens), DSH as
the client against the same local server. DSH 0.1.1-rc.2 at
`/home/ville/dev/deepseek-harness` (upstream-clean clone), run with an isolated
`DSH_HOME=/tmp/dsh-cap` whose `settings.yaml` is identical to `~/.dsh` except the
provider `baseURL` points at the probe on 8878 — the real `~/.dsh` is never
touched, so there is no settings flip and no restore step.

Session created on the shipped **minimal** preset
(`apps/cli/config/agent-presets/minimal/agent.cordis.yml`) through the web app's
apiproxy: `session.create {agentPreset: "minimal"}` + `session.prompt`. The
web-app bundle disables all 24 host-plane model-facing rows, so the model-facing
content is exactly the preset: a 5-word persona + 2 tools. One 3,591-byte OpenAI
`/v1/chat/completions` body captured (6 identical retries — the PONG replies are
malformed to the OpenAI client, so DSH replayed the same request). Raw captures
preserved in `floor-captures/dsh-minimal-2026-09-26/`; the isolated probe home in
`floor-captures/dsh-cap-isolated-home/`.

Priced with Qwen's own tokenizer (OpenAI-format variant of the pricer, preserved:
`floor-captures/price-floor-openai.py`, CPU only):

| Floor item | Qwen tokens |
|---|---:|
| System persona ("You are a helpful software engineer assistant.") | 8 |
| Tool `bash` | 225 |
| Tool `str_replace_editor` | 621 |
| Tools subtotal | 846 |
| First user turn (29-char probe prompt) | 7 |
| **Measured floor (raw sum)** | **861** |

= **0.7% of the 131,072 ceiling** — a **~21× reduction** over the CC baseline of
18,196 (13.9%, step 1). On the harness-machinery-only comparison (excluding the
first user turn): CC 16,731 → DSH Minimal 854, a **~20×** reduction.

The floor sits under the design's own 3.5–5k target by a 4–6× margin, and under
the CC 7-tool core (~5.1k, step 1) as well: the 2-tool core (bash + a single
`str_replace_editor` that folds read/create/edit) replaces CC's separate file
tools, and this tier carries no web, skill catalog, or environment block.

**What the 861 is, and is not.** It is the floor of a *bare* agentic shell — bash
+ file editing + one persona line, with the DSH host plane (session loop, tool
dispatcher, retries, web UI) behind it. It is **not** a working fleet harness: no
fleet identity, no lean seed, no handoff rule, no GPU discipline, no memory, no
index, and no safety (path allow-lists, command patterns, approval cards). The
tiny floor is the *price of none of that*.

**Caveats** (same house style as step 1): raw wire fields priced — the Qwen chat
template's per-message role/special tokens are not in this sum (step 1 had the
same gap); PONG-mode retries; web-app preset (the CLI preset carries the same
model-facing content); ±10% class number.

## What step 2 does to the decision fork

The number re-weights the open fork. The design argued for a custom Python shell
(~500–1500 LOC) partly on the ground that CC's ~20% "protocol plumbing" would be
owned alone. DSH Minimal shows that plumbing already exists — a working
bash + file-editing + session + retries agentic loop at 861 tokens, extensible via
`agent-presets`. The live question is no longer "can we get the floor down?"
(answer: to ~0.7%) but **whether the fleet's encoded behavior and safety can be
expressed as a DSH preset/config, or force a custom shell.** Prompt content
(fleet identity, the ≤2.5k lean guide, the 70k handoff rule) is likely expressible
as a preset's system + guide block; the safety layer (path allow-lists, command
patterns, hard output truncation, approval cards) is the uncertain part — the
shipped `bash`/`str_replace_editor` presets show no path allow-list.

**Next (step 3):** read the DSH preset/config surface to sort {identity, lean
guide, handoff rule, path allow-list, command pattern, output truncation, approval
card} into expressible-in-config vs requires-code. That decides the body: a custom
DSH `lean` preset/profile on the minimal core (config-only), a DSH plugin, or a
custom Python shell.

## Step 3 — the preset/config surface (2026-09-27, read from the 0.1.1-rc.2 clone)

Three scoped readers walked `/home/ville/dev/deepseek-harness`; every
load-bearing claim below was re-verified against source (file:line in that
repo). Question from the fork: can the fleet's behavior + safety be expressed
as a DSH preset/config, or do they force a custom shell?

### The seven items, sorted

| Item | Verdict | Where |
|---|---|---|
| Identity | **config** | the preset's `persona` row (`@deepseek-ai/dsh-persona`, `packages/preset/persona/src/index.ts`): `text` + `complete: true` — core assembly (`packages/core/system-prompt/src/index.ts:505-541`) keeps *only* the complete section after the assembly waterfall, so no host-plane identity, tool guidance, or listener can add text; `includeRuntimeContext: false` empties the runtime-context snapshot. Second complete section throws; a second same-name section in one scope also throws. |
| Lean guide (≤2.5k) | **config** | concatenated into the same `persona.text`. No generic second text-section entry ships (a separate block would need a small `systemPrompt.section()` plugin — not needed). Alternative route: `dsh-agent-instructions` auto-loads AGENTS.md/CLAUDE.md from cwd→root + a `$DSH_HOME` global, byte-budgeted via `maxBytes` — the right home for per-project notes, not static fleet behavior. |
| Handoff rule (70k finish) | prompt part **config** (persona text); the enforcement tool **plugin code** | DSH compaction triggers on pressure/overflow only (`compaction-basic`: `thresholdRatio` 0.8 / `retainRatio` 0.16 / `auto`; no custom finish threshold), and the 128k input+output ceiling is vLLM-specific — so the rule stays prompt text + a `handoff` tool that writes notes.md. |
| Path allow-list | **plugin code** | a `tools/pre-execute` waterfall listener (`packages/core/tools/src/index.ts:152`): `allow \| deny{reason} \| ask{reason}` before dispatch; the editor's `path` arg is the inspectable input. The `fs-local` doc names this exact seam ("enforce containment with … a `tools/execute` permission plugin"); `fs-local`'s config is only `{cwd, diffBasisMaxBytes}` — `cwd` is explicitly "NOT a containment boundary". |
| Command patterns | **plugin code** | same gate on the bash `command` arg. The bash tools ship no allow/deny/pattern config — only timeouts/shell/PTY knobs. |
| Output truncation | **config** | `maxOutputChars` on persistent bash (default 16,000) and on str_replace_editor (the minimal preset sets 16,000); one-shot bash has `maxOutputBytes` 64 KB with a spill file. |
| Approval card | **config** (on/off) + the gate's `ask` | `user-approval` `policy: ask\|never` (default `ask`, fail-closed); a pre-execute `ask` executes only after the approval service returns `allowed-once`, otherwise denies; the web UI already renders the escalation card (`approval/request` bridged by the host apiproxy). The operator loop is *wired*, not bolted on. |

Two supporting seams found in the same pass:

- **Profile patches** (`applyEntryPatches`, `vendor/include/src/index.ts:58-128`):
  layers are bundle patch → profile `cordis.patch.yml` → `--patch`. ADD via
  `insert` (no id → root; id → a group's config); OVERRIDE is whole-`config`
  *replace* (no deep merge); no delete — disable via `disabled: true`;
  unmatched id → warn + skip. The existing `~/.dsh/profiles/lean/` skeleton is
  the right shape.
- **Sandbox** (`@deepseek-ai/dsh-sandbox-policy`): `mode`
  (`read-only`/`workspace-write`/`danger-full-access`) + `workspaceRoot`,
  enforced by bwrap/Landlock/Seatbelt on **subprocess file-write effects**.
  That is the coarse fence; the pre-execute gate is the fine one. The base
  bundle defaults to `DSH_PERMISSION_MODE ?? workspace-write`.

### The body's answer

**The custom Python shell is off the table.** The design's "500–1500 LOC
harness we own alone" collapses to:

1. **A `lean` agent preset** (config only, ~1 file): fleet identity + lean
   guide + handoff rule in one `persona.text` (complete, no runtime context);
   the 2-tool core (bash + str_replace_editor) with `maxOutputChars` tuned;
   sandbox `workspace-write` + `workspaceRoot`; approval `ask`; the
   compaction decision (minimal ships without it — compaction becomes the
   backstop, the handoff rule the primary finish control).
2. **One out-of-tree plugin package** (~150–300 LOC): a `tools/pre-execute`
   gate (path allow-list + command patterns → allow/deny/ask; `ask` rides the
   existing card) + the `handoff` tool (`ctx.tools.register(defineTool({...}))`).
   Minimal shape per the shipped editor package: export `name`,
   `inject: ['tools', 'fs']`, a zod `Config`, and `apply(ctx, config)`.
   Installs via `dsh plugin --profile lean add <local path>` — profiles are
   the node-resolution anchor, so it lives beside `~/.dsh`. No core fork.

Kept from DSH: session loop, retries, web UI, approval plumbing, sandbox.
Owned by us: one preset file + one small package.

### Open items for the build

- **Escalation path**: the minimal preset's *persistent* bash has no
  sandbox-escalation wiring (`sandbox_permissions` + `justification` live on
  the one-shot `bash` tool). The pre-execute gate does not depend on it, but
  the denial→escalation→card path for an out-of-workspace write needs
  verification under `lean` (either mount the one-shot row too, or have the
  gate handle the ask directly).
- **Templating**: the standard persona uses `{{model}}`/`{{cwd}}` — confirm
  templating applies to custom `persona.text`.
- **Floor re-measurement**: `lean` with the fleet persona will price above
  861 (the guide is ~1–2.5k tokens). Re-measure the *built* preset with the
  same wire-capture probe + pricer before the pre-registered CC-Qwen vs
  lean-Qwen benchmark; do not reuse the bare-861 number for it.

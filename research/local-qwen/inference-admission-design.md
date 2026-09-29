# Local Qwen inference admission and Fleet QoS

**Status:** Accepted architecture; Phases 0–2 complete, Phase 3 full admission next
**Date:** 2026-09-27
**Scope:** All local clients of the Qwen3.8-27B vLLM endpoint, with Fleet and
DSH as the first-class callers
**Decision owner:** Ville

## Decision

Before local Qwen becomes the model behind every Fleet development session,
land a shared inference-admission layer in front of vLLM.

The admission layer schedules **individual model requests**, not agent
sessions. It provides bounded admission, work classes, weighted fairness,
ageing, cancellation, queue deadlines, and operator-visible telemetry. vLLM
continues to own GPU batching, KV allocation, token scheduling, and generation.

The natural enforcement point is the existing `dsh-serve` TCP-to-UDS proxy:
every supported client already reaches vLLM through it, while vLLM's Unix
socket is private to the launcher. DSH receives a small provider-neutral
scheduling contract and uses a two-phase permit path so time spent waiting for
admission does not count as an idle model stream. Legacy callers use a bounded
one-phase compatibility path through the same proxy.

Do **not** represent inference calls as ARM leases. ARM remains the authority
for coarse box-resource tenancy: the long-lived vLLM server owns the GPU.
Inference admission is a different lifetime and scheduling problem.

## Why this is needed

### Current topology

```text
Fleet devs ─┐
DSH chats ──┼── HTTP :8001 ── dsh-serve proxy ── UDS ── vLLM ── GPU
CC/Qwen ────┤
probes ─────┘

ARM lease:  [---------------- vLLM server lifetime ----------------]
```

ARM grants one exclusive GPU lease to the server process. It neither sees nor
schedules the inference requests inside that lease.

Fleet already serializes delivery within one developer session. Its drain loop
runs at most one pass per developer, but separate developers can run at the
same time. This is correct: independent agents must remain independently
responsive. It also means that moving the full Fleet to one local model creates
real cross-session inference concurrency.

DSH currently has no global admission controller or rate limiter. Its agent
loop can issue concurrent requests from independent sessions, and the
`GenerateOptions` contract has no request-priority or tenant field. The local
pi-ai route starts a five-minute stream-idle watchdog before awaiting provider
output and applies the normal bounded retry policy unless configured otherwise.

### What vLLM already does well

The running vLLM is not naive. It has:

- continuous batching;
- an internal waiting queue;
- FCFS scheduling by default;
- `--max-num-seqs 16` as an upper bound on running sequences;
- chunked prefill;
- a 5 GiB KV-cache allocation for the current `unsloth` profile;
- `scheduler_reserve_full_isl=true`, which checks whether a request's full
  input sequence fits before admission and prevents over-admission caused by
  chunked prefill;
- metrics for running/waiting requests, queue time, TTFT, KV use, and
  preemptions.

`max-num-seqs 16` is not a promise that sixteen long agent requests can run.
The KV budget is the tighter constraint. In the observed workload the engine
usually admitted one to three requests and left the remainder in its waiting
queue.

This is a sound GPU scheduler. It should remain the final authority on what can
fit in KV cache and what tokens run in each engine step.

### Evidence from the live server

A snapshot taken on 2026-09-27 after 640 completed requests showed:

| Signal | Observed value |
|---|---:|
| Successful requests | 640 |
| Request errors / aborts | 0 / 0 |
| KV preemptions | 2 |
| Mean vLLM queue time | 6.7 s |
| Requests queued over 60 s | 14 |
| Requests queued over 120 s | 3 |
| Mean time to first token | 15.8 s |
| Mean end-to-end request time | 35.1 s |
| Common running count | 1–3 |
| Observed waiting count | 0–3 |

The result is important: current contention is mostly **orderly queueing**, not
destructive KV thrashing. The engine completed every measured request and
preempted only twice. But the latency tail already exists before all Fleet
developers use this model.

### The failure mode at Fleet scale

FCFS is unaware of intent. It treats these as equivalent:

- a direct operator question;
- a normal autonomous developer turn;
- a 70k-token background investigation;
- a title-generation call;
- a permission/security classifier;
- a batch or probe request.

A long background prefill or decode can therefore sit in front of a tiny
interactive call. As load rises, this becomes a convoy:

1. More sessions enter vLLM's opaque FCFS queue.
2. TTFT rises even when generation throughput remains healthy.
3. Callers cannot explain whether they are queued, stalled, or dead.
4. A request that receives no stream data for five minutes trips DSH's stream
   watchdog.
5. The normal retry policy can submit another copy into the same congested
   service unless local-route policy prevents it.

The primary risk is therefore **unbounded latency and retry amplification**.
KV thrashing remains a secondary risk if native priority preemption or overly
aggressive concurrency is later enabled.

## Goals

1. Keep direct operator work responsive during background Fleet activity.
2. Preserve vLLM continuous batching and aggregate throughput.
3. Bound how much work is admitted ahead of vLLM.
4. Prevent one developer, subagent fan-out, or batch from monopolizing service.
5. Make queueing visible and distinguish it from model failure.
6. Remove queued work promptly when its caller disconnects or cancels.
7. Prevent admission delay from triggering stream-idle retries.
8. Retain a safe compatibility path for clients that do not know the permit
   protocol.
9. Keep ARM as the single source of truth for GPU ownership.
10. Fail closed and legibly under overload; never silently drop an agent turn.

## Non-goals

- Scheduling Fleet tasks or deciding which developer should exist.
- Reserving the GPU for an agent during shell commands, editing, or human
  think time.
- Replacing vLLM's token scheduler or KV-cache manager.
- Guaranteeing low latency when a single request nearly fills the entire KV
  cache.
- Persisting inference requests across proxy/server restarts.
- Distributing requests across multiple hosts in the first version.
- Extending ARM with millisecond-scale leases.
- Solving model quality, context compaction, or the lean persona itself.

## Responsibility boundaries

| Component | Owns | Does not own |
|---|---|---|
| ARM | GPU/RAM tenancy, priority between box workloads, vLLM server lease | Per-request inference order |
| Fleet | Developer/task intent, interactive vs background classification, operator UI | GPU/KV scheduling |
| DSH | Agent loop, request construction, cancellation, permit acquisition | Global capacity truth |
| Admission proxy | Global request queue, fairness, permits, deadlines, queue telemetry | Token-level GPU scheduling |
| vLLM | Tokenization, batching, KV fit, prefill/decode, generation | Fleet intent and tenant fairness |

The admission proxy may consume vLLM metrics as signals, but vLLM remains
authoritative. A stale metric must never cause the proxy to claim that a
request fits in KV cache.

## Proposed architecture

```text
                  scheduling metadata
Fleet ── DSH ─────────────────────────────┐
                                          │ acquire permit
                                          ▼
                                  ┌──────────────────┐
Legacy OpenAI/Anthropic clients ─▶│ admission proxy  │
                                  │                  │
                                  │ queues + permits │
                                  │ fairness + stats │
                                  └────────┬─────────┘
                                           │ bounded admitted set
                                           ▼
                                  vLLM UDS scheduler
                                           │
                                           ▼
                                          GPU
```

The proxy remains bound to `127.0.0.1:8001`; vLLM remains bound only to its
Unix socket. There must be no second routable path that bypasses admission.

### Why the proxy is the global boundary

- It sees DSH, Fleet, CC/Qwen, probes, and future local clients.
- It already parses and rewrites `/v1/messages` requests and streams responses.
- It is colocated with the server lifecycle and has a single process-wide view
  of active connections.
- It can remove a queued request when the TCP client disappears.
- A Fleet-only semaphore would not cover non-Fleet clients.
- A DSH-only plugin would not cover Claude Code or direct OpenAI requests.

Admission state is intentionally ephemeral. If the proxy exits, queued callers
receive connection failure and no hidden work survives. Under the current
supervisor contract, proxy death also tears down vLLM; changing that lifecycle
is a separate availability design and is not required for scheduling
correctness.

## Request classification contract

DSH adds provider-neutral scheduling metadata to `GenerateOptions`:

```ts
interface RequestScheduling {
  class: 'control' | 'interactive' | 'agent' | 'background'
  tenant?: string
  purpose?: string
  deadlineMs?: number
}
```

`tenant` identifies the fairness domain, normally a Fleet developer identity,
not a human-readable prompt and not a secret. DSH maps it to loopback headers;
remote providers never receive these fields.

Suggested loopback headers:

```text
X-Aivan-Work-Class: interactive
X-Aivan-Tenant: fe
X-Aivan-Purpose: operator-turn
X-Aivan-Request-Id: <opaque id>
X-Aivan-Queue-Deadline-Ms: 120000
X-Aivan-Admission: <single-use permit, admitted path only>
```

The proxy strips every `X-Aivan-*` header before forwarding to vLLM. Header
values are length-bounded and validated. Metrics never use tenant or request ID
as labels because that creates unbounded cardinality.

### Work classes

| Class | Examples | Initial weight | Constraints |
|---|---|---:|---|
| `control` | bounded permission/security decision required to unblock a turn | 16 | Strict input/output cap; oversized calls are downgraded |
| `interactive` | operator is directly awaiting this answer | 8 | May use reserved interactive capacity |
| `agent` | ordinary Fleet developer turn | 4 | Default for identified DSH/Fleet work |
| `background` | subagent, title, probe, batch, speculative work | 1 | At most one admitted per tenant initially |

Health checks and metrics scrapes bypass inference admission because they do
not enter the model.

`control` must remain rare and mechanically bounded. It is not a magic label
for “important.” A request that exceeds the configured control input size or
output cap is downgraded to `interactive` or `agent`, and the downgrade is
logged. Once the DSH gate makes permission decisions locally, most DSH work
will not need control-class model calls at all.

Unknown clients default to `agent`, tenant `legacy`. A client cannot obtain
more service by omitting metadata. Locally trusted integrations may claim a
class; external network access remains prohibited by binding to loopback.

### Fleet mapping

- A turn caused by the operator typing directly to a developer is
  `interactive`.
- A developer continuing autonomous assigned work is `agent`.
- A child agent, scheduled audit, title call, probe, or batch is `background`.
- Compaction is `agent` with purpose `compaction`: it can be large and should
  not masquerade as a tiny control call, but it must not starve indefinitely
  because the session cannot proceed without it.
- An actual bounded permission classifier is `control`.
- An urgent Fleet message changes mailbox delivery order; it does not
  automatically preempt a running GPU request. Its next model request becomes
  `interactive` if the operator is waiting for it.

## Two-phase admission for DSH

Waiting inside an OpenAI streaming request starts the provider's idle clock.
To keep admission delay outside that clock, DSH-aware clients acquire a permit
before invoking the model adapter.

### Acquire

```http
POST /_aivan/admission/acquire
Content-Type: application/json

{
  "requestId": "...",
  "class": "interactive",
  "tenant": "fe",
  "purpose": "operator-turn",
  "estimatedInputTokens": 12000,
  "requestedOutputTokens": 8192,
  "deadlineMs": 120000
}
```

The acquire call waits until selected, is cancelled when its HTTP connection
closes, and returns:

```json
{
  "permit": "opaque-single-use-token",
  "expiresInMs": 5000,
  "queueWaitMs": 1834
}
```

The DSH `llm/stream` admission plugin awaits this response **before** calling
the adapter. Consequently the pi-ai stream-idle watchdog starts only after
admission.

### Consume

The subsequent `/v1/chat/completions` request carries the permit. A permit:

- is random, opaque, and single use;
- is bound to the request ID, class, and tenant;
- reserves one admission slot for at most five seconds;
- is consumed atomically when the model request arrives;
- is released if it expires before consumption;
- cannot be reused for a second request.

Once the backend stream ends, errors, or is cancelled, the proxy releases the
active slot and schedules the next waiter.

### Compatibility path

A request without a permit is inserted directly into the same scheduler using
validated headers or default `agent/legacy` metadata. Its HTTP connection
waits at the proxy until admitted. This preserves existing clients but cannot
move the wait outside their own timeout machinery.

Compatibility requests therefore have a queue deadline below the caller's
known idle timeout. On expiry the proxy returns a structured overload response
and removes the request. The local DSH route must not blindly retry admission
expiry or stream-idle timeout; otherwise overload multiplies work.

Claude/Qwen's known auto-mode classifier can be recognized by the existing
proxy rewrite and classified as bounded `control`. Other heuristic prompt
inspection must not become the normal classification mechanism; explicit
metadata is the durable contract.

## Scheduling policy

### Principle

Keep vLLM's internal waiting queue shallow. The proxy decides **which requests
are offered** to vLLM; vLLM decides **which offered requests can run** and how
their tokens are batched.

### Initial capacity

Start with:

- `max_active_requests = 2`;
- `max_active_background_per_tenant = 1`;
- one of the two slots unavailable to `background` when any
  interactive/control/agent waiter exists;
- bounded total queue length, initially 64;
- bounded queued request-body bytes, initially 64 MiB;
- a per-tenant queued-request bound, initially 8.

These are conservative bootstrap values, not permanent truths. The live engine
has safely run three requests in some prompt mixes, but two is the common
KV-limited operating point. Load tests decide whether the admitted cap becomes
three or whether a short-request opportunistic lane is worthwhile.

Do not lower vLLM's `max-num-seqs 16` merely to match the proxy cap. The engine
still needs freedom for its own batching, future short calls, and controlled
experiments. The admission cap is hot policy; the vLLM limit is a hard engine
ceiling.

### Weighted fair queue with ageing

Within the queued set, use weighted deficit round robin across work classes,
then FCFS within each `(class, tenant)` queue. This avoids both a single strict
priority heap and one global FIFO.

Rules:

1. Each class receives service credits proportional to its weight.
2. A tenant may consume at most one class turn per round while peers in that
   class are waiting.
3. Cost is initially one request; a later token-aware phase may charge a
   conservative estimated-token cost.
4. Every queued request receives ageing credit.
5. A background request waiting longer than a configured threshold competes
   as `agent`; an agent request can age toward `interactive` service share but
   never becomes `control`.
6. FCFS breaks all equal-credit ties.
7. No queued request can be skipped merely because a later request is cheaper;
   bounded backfill, if added, must have an explicit maximum bypass count.

This gives interactive work a strong latency advantage without allowing an
endless interactive stream to starve maintenance and background progress.

### Token estimates

Request count is sufficient for the first enforcement release because vLLM
retains the real KV-fit decision. Still record:

- captured body bytes;
- client-supplied estimated input tokens when available;
- requested maximum output tokens;
- actual prompt/completion tokens from the final response.

DSH can estimate with the real local tokenizer before permit acquisition. The
proxy treats the estimate as advisory and bounds it against request size. Do
not import the heavyweight vLLM Python environment into the supervisor merely
to tokenize requests.

After calibration, token estimates may influence fair-queue cost and
opportunistic admission. They must not become a second, fallible KV allocator.

### Native vLLM priority

The installed vLLM supports `--scheduling-policy priority` and an OpenAI
`priority` field. Do not enable it in the first release.

Native priority can preempt the lowest-priority running request when KV
allocation fails. Preemption frees that request's blocks, resets its computed
tokens, and puts it back in the waiting queue. Frequent small high-priority
requests could therefore force expensive recomputation of long agent prompts.

The admission proxy can reorder work before dispatch without discarding live
KV state. Native priority remains an optional later experiment, gated by a
load test demonstrating improved interactive tail latency without materially
raising preemptions or reducing throughput.

## Cancellation, deadlines, and retry behavior

### Queued cancellation

- Closing an acquire connection removes its queue entry immediately.
- Cancelling a DSH turn aborts the acquire request.
- Closing a compatibility request before admission removes it immediately.
- Queue removal is idempotent and releases no slot unless the entry had a live
  reservation.

### Admitted cancellation

- Client disconnect propagates to the backend vLLM stream.
- The active slot is released only after backend cancellation has been sent or
  the backend stream has closed.
- A late backend frame after cancellation is discarded, never attached to a
  successor request.

### Deadlines

Deadline is a maximum queue wait, not a generation timeout. Suggested initial
defaults:

| Class | Queue deadline |
|---|---:|
| control | 30 s |
| interactive | 120 s |
| agent | 240 s |
| background | 600 s |

Fleet may requeue durable background work after a visible overload result.
Interactive expiry is surfaced to the operator as capacity exhaustion, not as
a fabricated model failure.

### Retry policy

The local DSH provider policy must be explicit. Admission expiry, queue-full,
and local stream-idle timeout are not blindly retryable inside the same agent
turn. Transport failure before permit consumption may retry once with the same
request ID; the server must make this idempotent. A retry after an admitted
stream begins is a new model attempt and follows normal agent-loop durability
rules.

The acceptance test must prove that one overloaded logical request produces at
most one queued inference request. This is the retry-amplification invariant.

## Overload behavior

The queue is bounded in memory and per tenant.

The proxy already has to parse a complete request body before forwarding it.
Permit-aware callers queue only small acquire records, but compatibility
callers may leave full model requests resident while waiting. Enforce both a
per-request body limit and a global queued-body-byte limit. A depth of 64 is
not a memory bound when request sizes vary. Language-only deployment makes the
initial 64 MiB aggregate practical; enabling inline media requires a separate
measurement and likely a lower compatibility depth or disk-backed bodies.

When full:

1. Existing queued requests keep their place.
2. New background work is rejected first.
3. A new interactive/control request may displace the newest not-yet-admitted
   background entry only if that behavior is explicitly enabled; the displaced
   caller receives a structured rejection immediately.
4. The scheduler never drops an entry silently.
5. Rejections contain a stable machine code, class, queue depth, oldest age,
   and a conservative retry-after value.

Suggested response:

```json
{
  "error": {
    "code": "LOCAL_MODEL_QUEUE_FULL",
    "message": "local Qwen admission queue is full",
    "workClass": "background",
    "queueDepth": 64,
    "oldestWaitMs": 48213,
    "retryAfterMs": 30000
  }
}
```

Do not synthesize an OpenAI completion from this response. DSH and Fleet must
preserve the capacity classification through their error surfaces.

## Observability

### Proxy metrics

Expose Prometheus metrics on the existing loopback metrics surface:

```text
aivan_admission_queue_depth{class}
aivan_admission_oldest_seconds{class}
aivan_admission_active{class}
aivan_admission_wait_seconds_bucket{class}
aivan_admission_requests_total{class,outcome}
aivan_admission_permits_total{outcome}
aivan_admission_queue_deadline_total{class}
aivan_admission_cancellations_total{phase}
aivan_admission_metadata_downgrade_total{reason}
```

Allowed labels are finite enums. Request IDs, tenant names, model prompts, and
paths never become metric labels.

### Structured events

For each request, log bounded records for:

- queued;
- admitted or permit issued;
- permit consumed/expired;
- backend started;
- first byte/first token observed;
- completed/cancelled/rejected;
- queue wait and service time;
- class, purpose, and a hashed or bounded tenant identifier.

Never log prompt bodies or credentials.

### Fleet status

Fleet should be able to render one shared service line such as:

```text
Qwen: 2 running · 4 queued · oldest 18s · KV 79% · p95 queue 31s
```

Each waiting developer should distinguish:

```text
queued for local Qwen (interactive, position 1, 7s)
```

from:

```text
local Qwen generating
```

Queue position is advisory because weighted fairness, cancellation, and ageing
can change order. Age and class are authoritative.

### Baseline retention

Save the pre-admission vLLM metrics snapshot and load-test inputs beside the
lean-harness benchmark evidence. Compare:

- aggregate output tokens/s;
- prompt tokens/s;
- p50/p95/p99 queue wait;
- p50/p95/p99 TTFT;
- end-to-end latency;
- preemptions;
- failures and retries;
- interactive versus background results separately.

## Failure handling

| Failure | Required behavior |
|---|---|
| Client disconnects while queued | Remove entry immediately |
| Client disconnects while active | Abort backend, then release slot |
| Permit expires | Release reservation; record expiry |
| Permit reused | Reject without forwarding |
| vLLM health fails | Stop issuing permits; fail queued work visibly |
| vLLM stream stalls | Existing backend idle timeout applies; release on closure |
| Proxy queue fills | Structured rejection; no silent drop |
| Proxy exits | Connections fail; queue is lost; supervisor lifecycle applies |
| Metrics scrape fails | Scheduling continues from local state |
| Invalid priority metadata | Downgrade to safe default and count it |
| Scheduler bug/invariant violation | Fail closed; do not bypass to vLLM |

The scheduler owns explicit invariants:

- active count never exceeds configured capacity;
- one permit can create at most one active request;
- every active request releases exactly once;
- queued plus reserved plus active equals all nonterminal tracked requests;
- a cancelled or expired request can never later be admitted;
- backend requests never exceed successful permit/direct admissions;
- no compatibility path reaches the UDS without scheduler accounting.

## Security and trust

- Bind all admission endpoints to loopback with the existing proxy.
- Keep the vLLM UDS non-routable to ordinary clients.
- Strip scheduling headers before forwarding.
- Bound every header and JSON field.
- Treat metadata as policy input, never shell input or a filesystem path.
- Do not log prompt bodies, bearer headers, permit tokens, or raw tenant IDs.
- Use cryptographically random permit tokens and compare them as opaque values.
- Expire permits quickly and remove consumed tokens.
- Validate control-class size to prevent a caller from turning every large job
  into high-priority work.
- The service is a local QoS boundary, not an authentication boundary. If the
  endpoint is ever exposed beyond loopback, authentication and class
  authorization become mandatory before that exposure.

## Implementation ownership

### `deepseek-harness`

1. Add optional provider-neutral request scheduling metadata.
2. Add an admission plugin around local `llm/stream` calls.
3. Acquire/cancel permits before invoking pi-ai.
4. Propagate stable overload classifications.
5. Configure the local route's retry policy to exclude queue overload and
   admission expiry.
6. Keep remote providers unaware of local scheduling headers.

### `dsh-serve`

1. Extend `_proxy` with the queue, permit registry, and scheduler.
2. Preserve existing request reframing, thinking rewrite, and streaming.
3. Add admission configuration to the model/profile register or launcher
   arguments with safe defaults.
4. Expose admission metrics and bounded structured logs.
5. Add status output for queue/active/oldest-wait state.
6. Keep direct health and metrics requests outside model admission.

### `aivan-fleet`

1. Map operator/dev/subagent/task intent to work classes.
2. Supply stable tenant and purpose metadata.
3. Show shared and per-developer queue state.
4. Preserve capacity failures in task/dev status.
5. Bound autonomous fan-out independently of model admission.

### `aivan-resource-manager`

No runtime changes are required. Document that ARM's `dsh` GPU lease covers
the model server and that inference requests are scheduled inside that lease.
ARM status may link to the admission status, but it must not duplicate it.

## Configuration sketch

Illustrative launcher/profile configuration:

```yaml
admission:
  enabled: true
  maxActiveRequests: 2
  maxQueuedRequests: 64
  maxQueuedBodyBytes: 67108864
  maxQueuedPerTenant: 8
  permitTtlMs: 5000
  classes:
    control:
      weight: 16
      queueDeadlineMs: 30000
      maxInputTokens: 16000
      maxOutputTokens: 1024
    interactive:
      weight: 8
      queueDeadlineMs: 120000
    agent:
      weight: 4
      queueDeadlineMs: 240000
    background:
      weight: 1
      queueDeadlineMs: 600000
      maxActivePerTenant: 1
  ageing:
    backgroundToAgentMs: 120000
    agentBoostEveryMs: 60000
```

Exact values remain deployment configuration and are changed only from load
evidence. The defaults must produce a safe server without Fleet installed.

## Verification strategy

### Unit tests with a fake clock

- weighted service ratios;
- FCFS within class/tenant;
- round-robin fairness between tenants;
- ageing and starvation bounds;
- active and per-tenant caps;
- queue-full behavior;
- permit issue, consumption, reuse, and expiry;
- queued and active cancellation races;
- exact-once release after every terminal path;
- invalid metadata downgrade;
- deterministic ordering under simultaneous arrival;
- no high-cardinality metric labels.

### Proxy integration tests with a scripted backend

- no more than the configured number of backend connections are active;
- streaming bytes are unchanged after admission;
- backend EOF, reset, malformed response, and slow stream release slots;
- a disconnected waiter never reaches the backend;
- a permit wait occurs before the DSH stream watchdog;
- compatibility callers share the same capacity pool;
- `/health` and `/metrics` remain responsive under a full queue;
- thinking-off classifier rewrite still happens before forwarding;
- overload produces one terminal error and no automatic request clone;
- proxy death retains the existing supervisor lifecycle guarantee.

### Fleet integration tests

- one busy developer does not block mailbox delivery to other developers;
- separate devs can queue concurrently but each dev keeps one turn chain;
- operator work is classified interactive;
- subagent work is classified background;
- queue state appears in `fleet status` and clears after cancellation;
- task state never claims “working” merely because inference is queued;
- an urgent message does not fabricate GPU preemption;
- restarting the service leaves no phantom queued state.

### Real GPU load matrix

Run representative agent requests, not synthetic one-token completions:

| Dimension | Values |
|---|---|
| Concurrent sessions | 1, 2, 4, 8 |
| Prompt size | 2k, 20k, 70k tokens |
| Output cap | 1k, 8k tokens |
| Work mix | all agent; interactive + background; control bursts |
| Tool loop | no tool; one tool; repeated short tool turns |
| Scheduler | unmanaged FCFS baseline; proxy admission |

Record throughput, queue distributions, TTFT, KV use, preemptions, completion
rate, and retry count. Repeat enough times that cold compile/startup is not
mistaken for steady-state contention.

### Initial acceptance criteria

1. No request corruption, duplicate model attempts, or silent drops.
2. Zero queue-induced retries in the admitted DSH path.
3. Interactive p95 queue time materially improves in the mixed 4-session test.
4. Background work makes progress during sustained interactive load.
5. Aggregate token throughput is no more than 10% below unmanaged vLLM at the
   same workload unless the latency improvement justifies and documents it.
6. Preemptions do not materially exceed the unmanaged baseline.
7. Queue and generation states are distinguishable in Fleet.
8. At eight sessions, overload is bounded and visible rather than timing out
   unpredictably.

Do not promise a fixed interactive latency until the load matrix establishes
what this GPU/model/KV configuration can sustain.

## Rollout

### Phase 0 — baseline and telemetry

- Preserve the current vLLM snapshot.
- Add a repeatable metrics capture and mixed-load script.
- Measure the unmanaged 1/2/4/8-session matrix.
- Confirm the local route's effective retry and idle-timeout behavior.

Closed 2026-09-29: `admission-bench/phase0-unmanaged-report.md` records the
direct-inference matrix (90/90 homogeneous and 9/9 mixed requests), the full
Lean-agent matrix (45/45 sessions, 101/101 tool calls, 161/161 model requests),
and the bounded end-to-end retry/idle-timeout proof. Phase 0's production
proxy/vLLM PIDs remained unchanged throughout.

### Phase 1 — metadata, no enforcement

- Add DSH scheduling metadata and Fleet classification.
- Log the class/purpose that each request would receive.
- Run in shadow mode: compute queue decisions without delaying requests.
- Audit incorrect classifications and cardinality.

Checkpoint 2026-09-29: DSH now has provider-neutral request scheduling
metadata, agent-level defaults, and an explicit pi-ai local-route header opt-in.
The proxy validates and strips that metadata, hashes tenants in logs, recognizes
the existing bounded permission classifier, and logs `would-admit` or
`would-queue` against a two-active-request shadow cap without delaying traffic.
An alternate-port probe against the live Qwen UDS returned 200 for simultaneous
legacy agent, explicit background, and classifier-control requests; the third
arrival logged `would-queue` and still ran. Unit/integration tests, the full
build, lint, and documentation gates are green. The production proxy keeps the
old process image until the next ordinary service restart because its
supervisor intentionally treats proxy-child replacement as fatal to the vLLM
lifecycle. Current Claude-compatible Fleet sessions remain legacy agent work
until a runtime integration can provide explicit per-turn intent; audit that
classification gap before Phase 1 closes.

Live audit 2026-09-30: after a normal service restart loaded the shadow proxy,
16/16 explicit 2K/20K/70K requests and 8/8 complete four-way Lean sessions
succeeded. The proxy classified all 46 inference requests in the captured
windows from explicit metadata, with zero legacy or downgraded decisions. The
Lean runs produced 22 agent turns across eight session tenants and eight
background title calls under one stable shared tenant; 23/23 tool calls
succeeded. An unmanaged long-context convoy delayed a 2K interactive request
to 46.1-second TTFT, and the shadow cap correctly marked arrivals above two as
`would-queue`. The DSH transport audit therefore passes. Phase 1 remains open
only for the Claude-compatible Fleet runtime bridge and its follow-up audit;
see `admission-bench/phase1-shadow-report.md`.

Fleet bridge checkpoint 2026-09-30: the repository now carries an opt-in,
provider-neutral `RequestScheduling` seam and a loopback-only per-session relay
for Claude-compatible runtimes. It classifies operator, developer, notice,
subagent, compaction, and genuine runtime-wake work without changing remote
backends. An isolated real SDK probe through the production shadow proxy
produced the required sequence `interactive parent → background subagent →
interactive parent` and completed with `SUBAGENT_OK`. A separate probe proved
that supplying a stable Fleet title removes the otherwise concurrent title
inference request.

The running Fleet daemon and config were deliberately left untouched. Phase 1
closes only after this build is deployed, `local_inference_scheduling` is
enabled on the loopback `qwen-local` backend at an operator-controlled restart,
and real Fleet shadow logs pass the same classification/cardinality audit.
Implementation details and the activation boundary are recorded in
`/home/ville/dev/aivan-fleet/coordination-docs/local-inference-scheduling.md`.

Fleet live audit 2026-09-30: the bridge was deployed and enabled on only the
loopback `qwen-local` backend. Operator, ordinary developer, notice, subagent,
and restored-parent generations all arrived with their expected explicit class
and purpose under one stable hashed tenant, with zero legacy or downgraded
generation traffic. The audit exposed and fixed a proxy prefix-match bug that
had counted `/v1/messages/count_tokens` as generation work; exact endpoint
matching now excludes those tokenizer-only calls from admission capacity. The
post-fix matrix passed and Phase 1 is closed. Full evidence is in
`admission-bench/phase1-fleet-shadow-report.md`.

### Phase 2 — permit protocol and background enforcement

- Land acquire/consume/cancel.
- Enforce bounds for background work first.
- Keep interactive/agent calls admitted while validating invariants.
- Prove queue wait is outside the stream-idle watchdog.

Closed 2026-09-30: DSH now acquires opaque five-second, single-use permits
before provider idle timing begins; the proxy validates, consumes, expires,
and revokes them and supplies a bounded compatibility queue for Fleet. Queue
and disconnect cancellation, permit misuse, deadlines, per-tenant depth, a
64 MiB queued-body aggregate, and a 64 MiB request-body ceiling are covered by
selftests. Live DSH traffic used the permit path, while a real Fleet turn with
two parallel same-tenant subagents held the second background request for
605 ms and then completed exactly. Interactive and agent calls remain
pass-through by design. The active profile disables retries until duplicate
acquire request IDs become idempotent. Full evidence and remaining boundaries
are in `admission-bench/phase2-background-report.md`.

### Phase 3 — full admission

- Enable `maxActiveRequests=2` for every inference path.
- Enable weighted fairness and ageing.
- Surface Fleet queue state.
- Run the acceptance load matrix.

### Phase 4 — Fleet migration

- Move a small set of devs to local Qwen.
- Compare queue/TTFT/task-completion metrics with the benchmark.
- Increase to all devs only after the mixed workload remains bounded.
- Keep subagent concurrency limits even after admission is stable.

### Phase 5 — tuning and optional native priority

- Test active capacity 3 against capacity 2.
- Calibrate token-aware cost.
- Consider an opportunistic short-request lane.
- Evaluate vLLM native priority only in an isolated benchmark with preemption
  and recomputation measured.

## Rollback

Provide one launcher/profile switch that disables admission enforcement while
leaving the existing proxy rewrite and streaming path intact. Rollback returns
to vLLM FCFS; it must not expose the UDS or require changing every client.

If permit-aware DSH encounters a proxy without the admission endpoint, startup
or route probing must detect that mismatch before a user turn. It may fall back
only when explicitly configured; silent fallback would make production appear
protected when it is not.

## Open questions to close with measurements

1. Is two active requests the best latency/throughput point, or does three win
   for typical lean-session prompt sizes?
2. What are p95 and p99 queue times for four and eight real agent sessions?
3. How much common-prefix reuse survives across independent lean sessions?
4. Should compaction have its own fairness class or remain aged `agent` work?
5. Is byte-derived token estimation sufficient for queue cost, or should DSH
   always use the real tokenizer?
6. What queue deadline gives useful overload feedback without creating task
   churn?
7. Does an SSE comment heartbeat help legacy streaming clients safely, or
   should legacy calls simply retain a deadline below their idle timeout?
8. Does native vLLM priority ever improve the mixed workload once proxy
   admission keeps the internal queue shallow?
9. Should the current supervisor's proxy/vLLM coupled lifecycle be changed for
   availability after scheduling is stable?

None of these questions blocks the architectural decision. They tune policy;
they do not change the boundary: ARM owns the server's GPU lease, the admission
proxy owns fair request entry, and vLLM owns GPU execution.

## Final recommendation

Finish the lean-Qwen agent and validate it independently, but treat admission
control as a prerequisite for switching the entire Fleet to the local model.
The current engine is stable and already queues safely; the work is not a new
GPU scheduler. It is the smaller and more tractable problem of adding shared
intent, bounded admission, fairness, cancellation, and visibility before load
reaches vLLM's FCFS queue.

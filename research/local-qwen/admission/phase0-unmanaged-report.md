# Phase 0 unmanaged inference baseline

Date: 2026-09-29

## Scope and status

**Phase 0 is complete.** It covers both concurrent direct streaming requests
through the production proxy/vLLM path and 1/2/4/8 complete Lean DSH sessions
performing no-tool, one-tool, and repeated-tool turns. A bounded isolated probe
also confirms the effective stream-idle/retry interaction end to end.

The runner, configurations, raw Prometheus snapshots, 100–250 ms metric
samples, exact generated inputs, per-request streaming observations, and
machine-readable summaries live in this directory. Every logical request made
one HTTP attempt. The endpoint had to be idle at each case boundary, and every
run checked that the proxy and vLLM PIDs were unchanged at completion.

## Matrix result

- 24 homogeneous cases: 1, 2, 4, and 8 concurrent requests crossed with 2k,
  20k, and 70k rendered inputs and 1k/8k output caps.
- 90/90 homogeneous requests completed successfully.
- 3 mixed cases and 9/9 mixed requests completed successfully.
- 2,760,000 homogeneous prompt tokens and 168,037 generated tokens were
  processed in 2,098.34 seconds of case wall time.
- One KV preemption occurred: 8 × 20k inputs with an 8k output cap at 100% KV.
- No request was retried, no transport failed, and the DSH proxy/vLLM processes
  remained unchanged.

## Capacity result

| Workload | Effective peak | Max waiting | Max KV | Client p95 TTFT | Result |
|---|---:|---:|---:|---:|---|
| 8 × 2k, 1k cap | 8 running | 5 | 38.8% | 1.62s | 8/8, no preemption |
| 8 × 2k, 8k cap | 8 running | 5 | 46.6% | 1.66s | 8/8, no preemption |
| 8 × 20k, 1k cap | 6 running | 7 | 99.0% | 39.77s | 8/8, no preemption |
| 8 × 20k, 8k cap | 6 running | 7 | 100.0% | 52.61s | 8/8, **1 preemption** |
| 8 × 70k, 1k cap | **2 running** | 7 | 95.1% | 189.18s | 8/8, 210.71s wall |
| 8 × 70k, 8k cap | **2 running** | 7 | 99.0% | 344.30s | 8/8, 447.31s wall |

`--max-num-seqs 16` is not usable long-context capacity. At 70k, full-input
reservation and the 5 GiB KV allocation limit this workload to two active
requests. Additional requests queue cleanly. At 20k, vLLM admits up to six in
the observed eight-client workload but reaches 99–100% KV and can preempt.

The server is stable under these tests: contention is primarily orderly FCFS
queueing, not destructive thrashing. The latency tail is nevertheless too
large for an interactive multi-session Fleet default.

## Convoy result

The mixed cases started background work first and injected a 2k interactive
request one second later. Work-class labels were evidence only; the unmanaged
proxy did not schedule from them.

| Interactive request | TTFT | E2E | Relative TTFT |
|---|---:|---:|---:|
| 2k control, alone | 0.43s | 4.92s | 1× |
| Behind 4 × 20k background | 9.00s | 13.91s | 20.8× |
| Behind 2 × 70k background | 31.06s | 36.40s | 71.7× |

This directly confirms the design's FCFS convoy concern. A small interactive
request is technically accepted and eventually completes, but vLLM has no
knowledge that it should outrank background work.

In the homogeneous 8 × 70k/8k-cap case, server queue-time p95 landed in the
480-second Prometheus bucket. A DSH provider watchdog that starts its
five-minute idle clock before admission can therefore time out and retry work
that is merely queued. Phase 2's two-phase permit path remains necessary so
queue wait occurs before the stream-idle watchdog.

## Initial policy implications

1. Start full admission testing at `maxActiveRequests=2`. It is the only cap
   demonstrated safe across 70k requests and matches the design default.
2. Do not infer that active capacity two is throughput-optimal for short work.
   Short 2k requests batch efficiently at eight-way concurrency, so later
   token-aware admission or an opportunistic short lane may recover throughput.
3. Keep vLLM as the final KV authority. The proxy cap bounds work ahead of it;
   it does not predict exact fit.
4. Add class-aware fairness before broad Fleet rollout. The mixed result shows
   a 21–72× interactive TTFT penalty under unmanaged FCFS.
5. Exclude queue overload from automatic retries and put permit waiting outside
   the existing stream-idle timeout.

## Complete Lean-agent result

The isolated DSH matrix ran 45 complete sessions and generated 161 provider
requests (agent steps plus auxiliary title requests) against the unchanged
production Qwen service:

- 45/45 sessions reached `turn/end`.
- 161/161 provider requests returned HTTP 200.
- 101/101 observed tool calls succeeded.
- All 15 repeated-tool workspaces contained the requested, marker-valid
  `summary.md` artifact.
- 299,094 prompt tokens and 13,270 generated tokens were processed.
- There were zero KV preemptions and zero model retries.
- Production proxy and vLLM PIDs remained unchanged; isolated DSH/tee ports
  were clear after teardown.

| Turn type | c1 wall | c2 wall | c4 wall | c8 wall | c8 waiting / KV | Tools |
|---|---:|---:|---:|---:|---:|---:|
| No tool | 7.76s | 8.95s | 17.55s | 10.92s | 14 / 54.4% | 0/0 |
| One tool | 6.66s | 6.65s | 9.26s | 10.76s | 11 / 57.3% | 15/15 |
| Repeated tool | 19.03s | 22.98s | 23.53s | 31.79s | 14 / 61.2% | 86/86 |

The observed running and waiting counts include auxiliary title requests, so
they may exceed the number of sessions. These short-context Lean turns batch
well at eight sessions and do not justify serializing all local use. This does
not contradict the long-context result: admission must remain context-aware
enough to protect latency when 20k–70k requests coexist with short turns.

## Effective timeout and retry result

The installed local provider omits both settings, so DSH resolves:

- `streamIdleTimeoutMs = 300000` (five minutes per outstanding provider read,
  including the initial fetch before the first stream byte);
- normal retry policy with five retries after the first attempt for
  `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, and `TRANSPORT`;
- exponential backoff from 500 ms to 10 seconds with 10% jitter;
- pi-ai SDK retries disabled, leaving durable DSH agent retries as the only
  request multiplier.

`results/retry-probe-2` verifies the mechanism through a real isolated Lean DSH
stack. With timing deliberately accelerated to a 750 ms idle timeout and the
budget bounded to two retries, a silent mock upstream observed exactly three
agent provider attempts. DSH emitted exactly two `llm/retry` and two
`llm/retry-started` events before a terminal `TIMEOUT`. One concurrent session
title request was separately identified and did not enter the agent retry
count. This is a mechanism proof, not a production-latency measurement.

Combined with the measured 480-second queue-time p95 bucket for 8 × 70k/8k,
the production defaults can amplify congestion to as many as six full agent
attempts. Phase 2 must place admission waiting outside this clock and make the
local retry policy explicit before enforcement is enabled.

## Evidence map

- `results/unmanaged-2k-o1k`
- `results/unmanaged-20k-o1k`
- `results/unmanaged-70k-o1k-v2`
- `results/unmanaged-2k-o8k`
- `results/unmanaged-20k-o8k`
- `results/unmanaged-70k-o8k`
- `results/unmanaged-mixed-1`
- `results/agents-1`
- `results/retry-probe-2`
- `results/unmanaged-70k-o1k-aborted-pre-request` records the prompt-sizing
  harness abort; no HTTP request was made and the run was superseded by v2.

## Phase 0 decision

Freeze this evidence as the unmanaged baseline and begin Phase 1 scheduling
metadata in shadow mode. The scheduler should preserve eight-way short-turn
batching where safe, but the first enforced release still starts at two active
requests because that is the only capacity demonstrated safe across 70k work.

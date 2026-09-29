# Phase 1 admission-shadow audit

**Date:** 2026-09-30
**Result:** DSH metadata transport and proxy classification pass; Phase 1 remains open for the Claude-compatible Fleet intent bridge.

## Service activation

The old service stopped cleanly and released the `gpu0` lease. A normal `dsh-serve start --uds --model unsloth --wait 900 --ready-timeout 900 --json` loaded the shadow proxy and returned healthy after 112 seconds. The active service is supervisor `1050766`, proxy `1050769`, and vLLM `1050770`, serving `Qwen3.8-27B` through the UDS proxy on port 8001. Both workload runners verified that these PIDs remained unchanged.

## Workloads

`phase1-shadow-1` issued 16 explicit requests through the production proxy:

- four simultaneous 2K prompts covering `control`, `interactive`, `agent`, and `background`;
- eight simultaneous prompts spanning 2K, 20K, and 70K contexts and all non-control work classes;
- two 70K background requests and one 20K agent request followed one second later by a 2K interactive request.

All 16 requests succeeded without retry or preemption. The eight-way mix reached 93.2% KV usage, six running requests, six waiting requests, a 40-second server queue-time p95 upper bound, and 54.3-second exact client TTFT p95. In the convoy case the delayed 2K interactive request had 46.1-second TTFT, while the already-running 20K agent request had 2.9-second TTFT. This reproduces the priority inversion that admission control must prevent.

`phase1-agents-shadow-1` ran four concurrent complete Lean sessions in each of two modes. All 8 sessions settled. The no-tool case completed in 10.9 seconds. The repeated-tool case completed in 26.1 seconds with 23/23 successful tool calls. Neither case preempted a request; their observed server queue-time p95 upper bounds were 0.8 seconds.

## Metadata audit

The captured workload windows contain 46 inference decisions:

| Workload | Requests | Explicit | Legacy | Downgraded | Would admit | Would queue | Max active |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Direct mixed-context | 16 | 16 | 0 | 0 | 6 | 10 | 8 |
| Complete Lean sessions | 30 | 30 | 0 | 0 | 7 | 23 | 8 |

The direct workload produced all four classes with 16 distinct tenant digests. The Lean workload produced 22 `agent/agent-turn` requests across eight session tenant digests and eight `background/session-title` requests under the single bounded legacy digest. Title generation does not currently receive a session tenant, but its shared background tenant is stable, carries no raw identifier, and does not create unbounded cardinality. No scheduling header reached vLLM because the proxy strips the complete `X-Aivan-*` family before relay.

The two-active shadow cap behaved mechanically as implemented: arrivals at active counts one and two logged `would-admit`; later concurrent arrivals logged `would-queue`. It did not delay or reject traffic.

## Decision

The local DSH metadata path is ready for Phase 2 protocol work. The evidence supports starting background-only permit enforcement at capacity two: four concurrent Lean sessions briefly generated eight inference requests because title calls overlapped agent turns, while the unmanaged long-context convoy delayed an interactive request by 46 seconds.

Phase 1 is not fully closed for Fleet. Current Claude-compatible sessions reach the proxy without the DSH request-scheduling API, so they remain `legacy agent` except for the recognized permission classifier. Before general enforcement, Fleet needs a runtime bridge that supplies a stable tenant and explicit `control`, `interactive`, `agent`, or `background` intent. After that bridge lands, repeat the four-class and multi-session audit and require zero unexpected legacy or downgraded requests.

Canonical evidence is in `results/phase1-shadow-1/` and `results/phase1-agents-shadow-1/`, including summaries, per-request results, metrics samples, and the extracted `proxy-shadow.log` files.

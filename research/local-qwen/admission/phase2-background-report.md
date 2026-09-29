# Phase 2 permit and background-enforcement audit

**Date:** 2026-09-30
**Result:** PASS for the deliberately limited Phase 2 policy
**Scope:** DSH two-phase permits plus background-only enforcement for DSH and
Fleet traffic through the production `dsh-serve` proxy

## What landed

The loopback proxy now owns a bounded admission controller. A DSH-aware pi-ai
route first calls `POST /_aivan/admission/acquire`, receives a cryptographically
random single-use permit, and attaches it to the immediately following model
request. The permit is bound to class, raw tenant, and request ID, expires
after five seconds, and is consumed atomically. A dropped acquire response
revokes its reservation; reuse, mismatch, queue expiry, and queue saturation
produce stable `ADMISSION_*` errors.

Permit acquisition happens after local context/image materialization and
before the provider stream and its idle watchdog exist. Queue wait therefore
cannot fire `LLM_STREAM_IDLE_TIMEOUT`. Caller cancellation still spans context
materialization, acquire, and streaming and retains the existing `ABORTED`
classification.

Compatibility clients such as Fleet carry the same scheduling headers but do
not acquire permits. Their complete HTTP request waits at the proxy and is
removed when the client disconnects. The queue is bounded to 64 entries,
eight per tenant, 64 MiB of aggregate queued compatibility bodies, and 64 MiB
per request. Scheduling metadata is stripped before vLLM.

Phase 2 intentionally enforces only background work: at most two total active
or reserved requests, and one active background request per tenant, must be
true before background admission. Interactive, agent, and control work remain
pass-through while contributing to the observed active count. This is not yet
the Phase 3 global capacity/fairness scheduler.

## Static and lifecycle verification

- Python compilation passed.
- Proxy selftests passed: `proxy-rewrite`, `proxy-stream`, `proxy-death`,
  `proxy-lifecycle`, `proxy-shadow`, and `proxy-admission`.
- The admission selftest covers same-tenant queuing, queued cancellation,
  disconnected clients, queue/body accounting, request-body rejection,
  permit consume/reuse/revoke, and final slot balance.
- The focused pi-ai suite passed 49/49 tests. Its delayed acquire fixture waits
  50 ms against a 10 ms stream-idle timeout and still completes, proving that
  acquire wait is outside the watchdog.
- Full DSH typecheck and lint passed.
- Config-catalog and translation-pair verification passed.
- The full documentation gate passed 28/28 checks.

An alternate-port probe against the live UDS had already demonstrated permit
lifecycle timing: a same-tenant background acquire waited 4.989 seconds until
the first reservation expired, its model request completed with HTTP 200, and
reuse returned `ADMISSION_PERMIT_INVALID`.

## Production DSH audit

After a normal DSH restart loaded the final proxy and adapter build, a real
headless turn returned exactly `DSH_PHASE2_FINAL_OK`. Its agent turn and
concurrent session-title request each acquired a permit, then reached
`/v1/chat/completions` through `path=permit`; both had zero queue wait and both
slots returned after their streams.

A prior three-session production probe returned all three exact expected
answers. Agent turns remained pass-through as designed. Their shared
background title tenant was serialized: the second and third title calls
waited 5.455 and 5.394 seconds. This proves enforcement rather than merely the
shadow decision.

## Production Fleet compatibility audit

Fleet remained live with `local_inference_scheduling: true` only on
`qwen-local`. A real operator turn launched two Agent tools in parallel and
returned exactly `FLEET_PHASE2_OK`.

The proxy observed:

| Request | Class/purpose | Path | Queue wait |
|---|---|---|---:|
| Parent turn | `interactive/operator-turn` | compatibility | 0 ms |
| First child | `background/subagent` | compatibility | 0 ms |
| Second child, same tenant | `background/subagent` | compatibility | 605 ms |
| Resumed parent | `interactive/operator-turn` | compatibility | 0 ms |

The second background call was therefore held until the first released its
per-tenant background slot. The interactive parent was not delayed after the
children completed. Fourteen successful `/v1/messages/count_tokens` calls
occurred after the turn and none entered admission accounting.

## Retry decision and remaining boundary

The live local profile uses `maxRetries: 0`. Queue-full, queue-deadline,
permit, timeout, and transport failures are not blindly retried in Phase 2.
Although acquire request IDs are stable within a single attempt, duplicate
acquires are not yet idempotent across an ambiguous response loss. A transport
retry could therefore create a second short-lived reservation. Implement and
test acquire idempotency before allowing the one permitted transport retry in
the architecture.

Phase 2 passes within its stated boundary. Phase 3 is next: replace
background-only gating with a global two-active scheduler, weighted fairness
and ageing; add queue/active/oldest state to operator status and metrics; then
run the full acceptance workload. Until that lands, non-background traffic can
still push vLLM above two active requests, and compatibility wait remains
inside Fleet's HTTP request lifetime.

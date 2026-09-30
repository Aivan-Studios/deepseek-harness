# Phase 3 full-admission audit

**Date:** 2026-09-30
**Result:** PASS for global two-request boundedness; mixed-context policy follow-up required

## Policy

Every generation path now shares a maximum of two active or reserved requests. Queued work receives smooth weighted service by effective class (`control=16`, `interactive=8`, `agent=4`, `background=1`), FCFS ordering within equal choices, and tenant alternation when peers share a class. Background work ages into the agent service share after 120 seconds; agent work ages into the interactive share after 60 seconds. The original one-active-background-per-tenant restriction remains in force.

The bounded queue and permit rules from Phase 2 remain unchanged. The proxy exposes `GET /_aivan/admission/status`, which reports aggregate active and queued counts by finite class, oldest wait by class, queued body bytes, and live permit count without raw tenants, request IDs, or permit values.

## Verification

Python compilation and all six proxy selftests passed. The admission selftest covers global capacity, weighted interactive-before-agent-before-background selection, ageing, eligible-tenant bypass when another background tenant is active, deadline cleanup, disconnect cancellation, queued-body bounds, and permit lifecycle. The 28-part documentation suite passed.

An alternate-port proxy against the production vLLM UDS held two agent permits, exposed one queued interactive request at 203 ms in its status response, and admitted it after 4.986 seconds when a reservation expired. The snapshot reported exactly two active agents, one queued interactive request, and two live permits.

The idempotency follow-up used another isolated proxy against the production UDS. Two sequential acquires with the same tenant, request ID, and metadata returned the same opaque permit; its reported TTL decreased from 5000 to 4988 ms rather than creating a fresh reservation. Reusing that identity with a different purpose returned HTTP 409 and `ADMISSION_REQUEST_CONFLICT`. The abandoned permit expired after five seconds, returning active and permit counts to zero. After production restart, a source-run headless DSH turn returned exactly `LIVE_IDEMPOTENCY_OK`; its agent and title calls both traversed reserve and permit-admit paths, and final admission state was empty.

## Production workload

After a normal restart loaded Phase 3, three concurrent permit-aware DSH sessions returned `PHASE3_DSH_1`, `PHASE3_DSH_2`, and `PHASE3_DSH_3`. The first agent and a title request occupied both slots. Later agent permits waited 3.410 and 8.290 seconds, and background title work waited 11.165 seconds. No admission record exceeded `active=2`, and queue time remained outside the provider idle watchdog.

A real Fleet operator turn launched two Agent subagents and returned `FLEET_PHASE3_OK`. The compatibility path preserved `interactive/operator-turn → background/subagent → background/subagent → interactive/operator-turn`; all requests completed and no active count exceeded two. Fourteen token-count requests bypassed admission.

## Remaining work

Phase 3 establishes bounded global scheduling and aggregate visibility. The follow-up idempotency increment coalesces concurrent duplicate acquire request IDs, recovers the same live permit after ambiguous response loss, rejects metadata conflicts and already-consumed duplicates, and makes exactly one same-ID client retry for acquire transport loss. Unit coverage proves that two duplicates create one queued request and one reservation.

The subsequent [mixed-context acceptance matrix](phase3-mixed-context-report.md) passed stability and boundedness but initially failed control-latency isolation: a control request arriving behind two active 70K backgrounds expired at the proxy's 30-second deadline. The corrected proxy now enforces a calibrated 130K aggregate estimated-token reservation while retaining the two-request ceiling and permitting one larger request to run alone. The production retest passed 3/3 with 16.061-second control TTFT, 51.5% peak KV, and zero preemptions. The mixed-context blocker is closed; Fleet status projection remains outstanding.

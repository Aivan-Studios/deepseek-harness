# Phase 3 full-admission audit

**Date:** 2026-09-30
**Result:** PASS for global two-request admission

## Policy

Every generation path now shares a maximum of two active or reserved requests. Queued work receives smooth weighted service by effective class (`control=16`, `interactive=8`, `agent=4`, `background=1`), FCFS ordering within equal choices, and tenant alternation when peers share a class. Background work ages into the agent service share after 120 seconds; agent work ages into the interactive share after 60 seconds. The original one-active-background-per-tenant restriction remains in force.

The bounded queue and permit rules from Phase 2 remain unchanged. The proxy exposes `GET /_aivan/admission/status`, which reports aggregate active and queued counts by finite class, oldest wait by class, queued body bytes, and live permit count without raw tenants, request IDs, or permit values.

## Verification

Python compilation and all six proxy selftests passed. The admission selftest covers global capacity, weighted interactive-before-agent-before-background selection, ageing, eligible-tenant bypass when another background tenant is active, deadline cleanup, disconnect cancellation, queued-body bounds, and permit lifecycle. The 28-part documentation suite passed.

An alternate-port proxy against the production vLLM UDS held two agent permits, exposed one queued interactive request at 203 ms in its status response, and admitted it after 4.986 seconds when a reservation expired. The snapshot reported exactly two active agents, one queued interactive request, and two live permits.

## Production workload

After a normal restart loaded Phase 3, three concurrent permit-aware DSH sessions returned `PHASE3_DSH_1`, `PHASE3_DSH_2`, and `PHASE3_DSH_3`. The first agent and a title request occupied both slots. Later agent permits waited 3.410 and 8.290 seconds, and background title work waited 11.165 seconds. No admission record exceeded `active=2`, and queue time remained outside the provider idle watchdog.

A real Fleet operator turn launched two Agent subagents and returned `FLEET_PHASE3_OK`. The compatibility path preserved `interactive/operator-turn → background/subagent → background/subagent → interactive/operator-turn`; all requests completed and no active count exceeded two. Fourteen token-count requests bypassed admission.

## Remaining work

Phase 3 establishes bounded global scheduling and aggregate visibility. Acquire retries remain disabled until duplicate request IDs are idempotent across ambiguous response loss. Fleet does not yet project the aggregate status in its operator UI, and the full mixed-context acceptance matrix remains the next audit before broad Fleet migration.

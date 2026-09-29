# Agent Note: local inference scheduling metadata

Status: implemented

English | [中文](2026-09-29-local-inference-scheduling-metadata.zh.md)

## Problem

The local Qwen proxy sees requests from independent agent sessions, auxiliary model calls, and Claude-compatible clients, but raw OpenAI and Anthropic requests carry no durable scheduling intent. vLLM can batch and queue them but cannot distinguish an operator turn from a title request or background work. Applying local headers to every pi-ai route would leak deployment policy to remote providers.

## Decision

`GenerateOptions.scheduling` carries model-hidden class, tenant, purpose, request id, and queue deadline metadata. `AgentOptions.scheduling` applies that intent to each conversation request without adding it to the durable model-visible session log.

The pi-ai adapter transports scheduling metadata only when a provider profile sets `schedulingHeaders: true`. Explicit metadata wins. Otherwise an opted-in route classifies session titles as background, compaction as agent, and ordinary session-bound calls as agent with their session id as the fairness tenant. Routes without the opt-in send no scheduling headers.

The loopback `dsh-serve` proxy validates the finite class set and bounded header values, hashes tenant values before logging, and strips all `X-Aivan-*` fields before forwarding to vLLM. Its Phase 1 shadow counter logs whether the measured two-active-request policy would admit or queue each generation request but never delays or rejects one. Token-counting endpoints bypass the generation counter because they allocate no generation slot or KV sequence. The existing Claude auto-mode permission classifier is recognized as bounded control work; other unmarked clients use `agent/legacy` semantics.

`admission: true` on a loopback pi-ai profile acquires a proxy permit before constructing the provider stream watchdog. The permit is opaque, single-use, bound to class, tenant, and request id, and expires after five seconds if it is not consumed. Phase 2 enforces the two-active and one-background-per-tenant bounds only for background work; other classes participate in active accounting but remain pass-through until weighted fairness is validated. Queue expiry, queue capacity, permit mismatch, and permit reuse return stable `ADMISSION_*` failures, which the local route's retry policy does not retry blindly.

## Alternatives considered

- **Put scheduling fields in provider-specific pi-ai options** — rejected because initiators and the agent loop own intent while adapters own transport.
- **Enable the headers for every pi-ai route** — rejected because local admission metadata must not reach remote providers.
- **Classify all requests by prompt inspection** — rejected because prompt heuristics are not a stable intent contract; only the existing classifier signature has an independent bounded-control requirement.
- **Enforce the two-request cap immediately** — rejected because Phase 1 exists to audit classifications and shadow decisions before request timing changes.

## Consequences

Local DSH traffic can be audited by class and bounded tenant identity without exposing prompts or tenant names to logs or vLLM. Current Claude-compatible Fleet sessions remain legacy agent traffic except for the known control classifier until their runtime adapter supplies explicit per-turn metadata. Shadow active counts describe concurrent generation requests at arrival, not tokenizer-only calls or vLLM KV fit, and do not replace the engine's scheduler.

DSH-aware calls wait before provider idle timing begins, while compatibility clients wait inside their HTTP request. A queued client disconnect cancels its wait and a dropped acquire response revokes its reservation. Background-only enforcement limits Phase 2 risk but permits non-background load to exceed two active requests; Phase 3 closes that deliberate gap with weighted fairness and ageing.

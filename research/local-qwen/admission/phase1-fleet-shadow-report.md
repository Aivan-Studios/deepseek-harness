# Phase 1 Fleet shadow audit

**Date:** 2026-09-30
**Result:** PASS
**Scope:** The activated Aivan Fleet scheduling-intent bridge through the production `dsh-serve` shadow proxy

## Activation

Fleet was built and restarted with `local_inference_scheduling: true` on only the loopback `qwen-local` backend. The production DSH proxy remained in shadow mode: it recorded admission decisions but did not delay or reject requests.

The transition confirmed an operational constraint: an old Fleet daemon can reread the authored config before it exits and reject the additive field. The safe sequence is deploy/restart onto the supporting build, add the field, then take the final new-build restart. The final daemon accepted the flag and retained all 18 registered devs and the messenger wire.

## Finding and correction

The first operator probe returned `FLEET_LIVE_OK` and classified its generation correctly as `interactive/operator-turn`. It also exposed fourteen `/v1/messages/count_tokens` requests that the proxy's prefix match incorrectly counted as inference, producing false active counts up to twelve and false `would-queue` decisions.

Token counting allocates no generation slot or KV sequence. The proxy now admits only exact generation endpoints (`/v1/messages`, `/v1/chat/completions`, and `/v1/completions`, with query strings allowed) into the generation counter. The fix passed Python compilation and the `proxy-rewrite`, `proxy-stream`, `proxy-death`, `proxy-lifecycle`, and `proxy-shadow` selftests. DSH was restarted normally to load it.

The post-fix operator probe returned `FLEET_POSTFIX_OK`. Its window contained one generation decision and fourteen successful token-count calls; only the generation appeared in shadow admission.

## Classification matrix

| Live Fleet operation | Expected | Observed | Result |
|---|---|---|---|
| Operator no-tool turn | `interactive/operator-turn` | one explicit request | pass |
| Operator parent around Agent tool | interactive → interactive | both explicit, restored after subagent | pass |
| Agent subagent | `background/subagent` | one explicit request | pass |
| TD question | `agent/fleet-turn` | one explicit request | pass |
| TD notice | `background/fleet-notice` | one explicit request | pass |
| SDK token counting | outside generation admission | 14 per simple turn, no shadow decision | pass |

The real Fleet subagent turn returned `FLEET_SUBAGENT_OK` and produced exactly `interactive parent → background subagent → interactive parent`. The TD probes returned `FLEET_AGENT_OK` and `FLEET_NOTICE_OK`.

Across the post-fix generation windows there were zero legacy classifications, zero downgraded classifications, one stable hashed tenant for the `qwen` dev, and no false queue decision. All audited requests completed successfully. Fleet, the DSH proxy, and vLLM remained healthy after the audit.

## Decision

Phase 1 passes. The Fleet bridge supplies explicit, bounded intent at the shared proxy, nested SDK activity restores the parent class, and non-generation calls no longer corrupt admission telemetry.

Phase 2 may begin with acquire/consume/cancel and background-only enforcement. Interactive and agent work remain non-enforcing until permit lifecycle, cancellation, queue-wait placement outside the stream-idle watchdog, and overload telemetry are proven under live contention.

The fourteen token-count calls per completed Fleet turn are observable CPU/network overhead but not GPU generation contention. Treat reduction as a separate runtime-efficiency investigation rather than charging them to the GPU admission queue.

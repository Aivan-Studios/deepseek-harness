# Phase 3 mixed-context acceptance matrix

**Date:** 2026-09-30

**Result:** PASS after token-headroom correction; initial count-only policy failed control-latency isolation

## Question

This matrix tested whether the 32 GiB Qwen deployment can safely run different context sizes through the Phase 3 two-request admission policy, and whether a latency-sensitive request remains usable when large work is already active. It did not test model quality. Deterministic text prompts were rendered with the deployed tokenizer to exactly 2K, 20K, 70K, or 110K input tokens. Every successful request generated exactly 128 tokens with thinking disabled, so the measurements isolate prefill and live KV pressure. Each logical request made one HTTP attempt.

The production proxy and vLLM stayed up under the same PIDs. vLLM metrics were sampled every 100 ms, and each case began only when the engine was idle. Scheduling headers exercised the enforced compatibility path, not a synthetic scheduler.

## Results

| Case | Result | Wall | TTFT observations | Peak KV | vLLM running / waiting | Preemptions |
|---|---:|---:|---|---:|---:|---:|
| 2K interactive | 1/1 | 2.69 s | 0.36 s | 4.9% | 1 / 0 | 0 |
| 20K + 20K agents | 2/2 | 7.99 s | 2.97 s, 5.46 s | 31.1% | 2 / 1 | 0 |
| 70K + 20K agents | 2/2 | 22.02 s | 19.25 s, 2.90 s | 62.1% | 2 / 1 | 0 |
| 70K + 70K agents | 2/2 | 36.34 s | 17.01 s, 33.56 s | 93.2% | 2 / 1 | 0 |
| 110K agent + 2K interactive | 2/2 | 38.68 s | 35.73 s, 0.32 s | 76.7% | 2 / 0 | 0 |
| 110K + 20K agents | 2/2 | 41.33 s | 38.37 s, 2.95 s | 87.4% | 2 / 1 | 0 |
| 110K + 110K agents | 2/2 | 77.09 s | 35.80 s, 74.27 s | 71.8% | 1 / 1 | 0 |
| two 70K backgrounds, then 2K interactive | 3/3 | 38.63 s | interactive 35.20 s | 93.2% | 2 / 1 | 0 |
| two 70K backgrounds, then 2K control | 2/3 | 36.27 s | control refused at 30.00 s | 93.2% | 2 / 1 | 0 |

The `running / waiting` columns are maxima and can both occur during one case: chunked prefill initially leaves a request waiting, after which compatible pairs coexist. Two 110K requests cannot coexist in the configured 5 GiB KV pool. vLLM safely serialized them with one running and one capacity-waiting request; it did not unload model weights, preempt, or recompute either request.

The most useful positive result is 110K plus 2K. When both arrived together, class scheduling admitted the interactive request promptly and it produced its first token in 0.32 seconds while the large request continued. Mixed sizes are therefore not inherently a problem.

## Acceptance failure

The current policy cannot protect a request that arrives after both admission slots contain long work. In the interactive convoy, the small request spent 34.938 seconds in the proxy and reached its first token at 35.201 seconds. Weighted selection cannot affect requests that have already crossed the admission boundary.

The control convoy turns that latency into a correctness failure. The small control request hit its 30-second queue deadline and received HTTP 429 while both background requests completed normally. A real auto-mode classifier has a bounded caller deadline, so broad Fleet migration cannot treat this as an acceptable slow response.

This is not contention thrashing: all completed requests returned exact token counts, peak KV remained below 94%, preemptions stayed at zero, the Phase 3 active count never exceeded two, and admission state returned to empty. It is an admission-policy headroom problem.

## Decision

Keep the live two-slot scheduler and its zero-agent-retry policy, but block Phase 4 broad migration until admission reserves practical headroom for control work. The next increment should carry a conservative input-token estimate on permit acquisition, derive a bounded estimate from compatibility request bytes, and prevent an admitted combination from consuming the calibrated KV budget. A single request larger than the budget must still run alone. Smaller control or interactive work may backfill remaining budget, while bypass accounting must keep a large queued request from starving.

The measured starting point is a conservative aggregate reservation below the 70K+70K case that reached 93.2% KV, followed by the same convoy and 110K boundary tests. Fleet queue-status projection remains useful but does not fix this failed invariant and should follow the policy correction.

## Token-headroom correction

The follow-up candidate keeps the two-request ceiling and adds a 130K estimated-token aggregate budget. Text-only permit clients send a conservative input estimate derived from their materialized context; compatibility requests derive it from complete request bytes at three bytes per token. Requested output is included. One request larger than the budget remains admissible alone. Token-fit bypass is bounded at eight before non-control backfill pauses.

Against an isolated candidate proxy, the previously failing control convoy passed 3/3. The proxy admitted one 70K background and the control request immediately, held the second background for 19.491 seconds, and the control request reached its first token in 15.753 seconds instead of receiving a 30-second 429. Peak KV fell from 93.2% to 51.5%; preemptions remained zero.

The boundary retest preserved useful concurrency: 110K+2K completed 2/2 with 0.455-second interactive TTFT, two vLLM running sequences, and 76.7% peak KV. The 110K+110K pair also completed 2/2, but the second request waited 38.289 seconds at the proxy instead of occupying a permit while waiting inside vLLM; vLLM waiting remained zero and total wall time was effectively unchanged at 76.73 seconds.

Production was restarted onto the corrected proxy and repeated the formerly failing convoy successfully, 3/3. Control TTFT was 16.061 seconds, the second background waited 19.829 seconds at the proxy, peak KV was 51.5%, and preemptions remained zero. Admission state returned to zero, and a subsequent permit-aware DSH turn returned exactly `TOKEN_HEADROOM_DSH_OK`. The mixed-context Phase 4 blocker is closed; Fleet aggregate-status projection remains the next rollout prerequisite.

Canonical raw evidence remains in `/home/ville/claude-qwen/admission-bench/results/phase3-mixed-context-1`, `/home/ville/claude-qwen/admission-bench/results/phase3-control-boundary-1`, `/home/ville/claude-qwen/admission-bench/results/phase3-control-token-aware-1`, `/home/ville/claude-qwen/admission-bench/results/phase3-token-aware-boundaries-1`, and `/home/ville/claude-qwen/admission-bench/results/phase3-control-production-token-aware-1` on the test host.

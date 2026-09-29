# Unmanaged local-Qwen concurrency baseline

This is Phase 0 of the [local Qwen inference admission design](../inference-admission-design.md). It measures the current vLLM FCFS behavior through the production DSH proxy before admission control changes scheduling.

The runner creates deterministic, tokenizer-measured repository-review prompts; starts each case's clients at one barrier; consumes streaming responses; samples vLLM metrics; and retains raw inputs, Prometheus snapshots, request results, summaries, and a Markdown report. Every logical request has exactly one HTTP attempt. A case refuses to start unless vLLM is idle, and the run fails if the DSH proxy or vLLM PID changes.

## Commands

```bash
cd /home/ville/claude-qwen/admission-bench
/home/ville/.venvs/vllm/bin/python -m unittest -v test_run_unmanaged.py
/home/ville/.venvs/vllm/bin/python run_unmanaged.py --config phase0-smoke.json --dry-run
/home/ville/.venvs/vllm/bin/python run_unmanaged.py --config phase0-smoke.json --run-id smoke-1
/home/ville/.venvs/vllm/bin/python run_unmanaged.py --config phase0-baseline.json --run-id unmanaged-1
/home/ville/.venvs/vllm/bin/python run_unmanaged.py --config phase0-mixed.json --run-id unmanaged-mixed-1
/home/ville/.venvs/vllm/bin/python run_agent_matrix.py --config phase0-agents.json --run-id agents-1
python3 retry_probe.py --run-id retry-probe-2
/home/ville/.venvs/vllm/bin/python run_unmanaged.py --config phase1-shadow.json --run-id phase1-shadow-1
/home/ville/.venvs/vllm/bin/python run_agent_matrix.py --config phase0-agents.json --run-id phase1-agents-shadow-1 --case no-tool-c4 --case repeated-tool-c4
```

Use repeatable run IDs and keep each result directory. `phase0-baseline.json` covers 1/2/4/8 clients, 2k/20k/70k prompts, and 1k/8k output caps. `--case NAME` may be repeated for a bounded subset. Do not compare runs if other clients used the local model during a case; the idle precondition detects activity only at the case boundary.

`phase0-mixed.json` measures FCFS convoying by starting background requests first and injecting a 2k interactive request one second later. Labels and intended work classes are evidence only in Phase 0; the unmanaged proxy does not schedule from them.

`run_agent_matrix.py` starts an isolated Lean DSH on port 3180 and a capture tee on 8878, then runs 1/2/4/8 complete sessions in no-tool, one-tool, and repeated-tool modes. Each session receives a separate Bubblewrap workspace. The runner tears down only the exact child processes it started and verifies that the production proxy and vLLM PIDs did not change.

The generated `report.md` is a convenience view. Canonical evidence is the per-case `requests.json`, `metrics-before.prom`, `metrics-after.prom`, and `metrics-samples.jsonl`. Server-side queue-time quantiles are Prometheus histogram upper bounds, while client TTFT and end-to-end quantiles use exact observations from this run.

`retry_probe.py` is a bounded end-to-end mechanism test. It starts an isolated
Lean DSH against a silent mock OpenAI endpoint, accelerates the idle timeout to
750 ms, and limits the policy to two retries. It must observe three agent
provider attempts, two durable retry events, and a terminal timeout. It never
addresses or restarts the production Qwen service; do not interpret its timing
as a production deadline measurement.

`phase1-shadow.json` is the live shadow-classification audit. Unlike the Phase
0 labels, its `scheduling` objects become real `X-Aivan-*` request headers. The
runner records only the intended metadata in its inputs; the production proxy
validates, logs, and removes those headers before forwarding to vLLM. The Phase
1 agent run opts its isolated local route into the same headers so complete
Lean session and title traffic is included in the audit.

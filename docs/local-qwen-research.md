# Local Qwen and Lean harness research

English | [中文](local-qwen-research.zh.md)

This reference locates the evidence used for the repository's local Qwen deployment. The research covers the Lean preset and persona, prompt and tool-schema cost, Claude Code comparisons, long-context and output-cap behavior, proxy failure handling, and shared inference admission for DSH and Fleet.

The versioned [research archive](../research/local-qwen/index.md) preserves the complete working documents and benchmark conclusions. Those records explain why the deployment uses the pi-ai adapter, the `dsh-serve` TCP-to-UDS proxy, model-hidden scheduling metadata, and two-phase admission permits.

Current runtime contracts remain in the owning documentation:

- [pi-ai adapter README](../packages/llm/llm-pi-ai/README.md) defines provider configuration, scheduling headers, permit acquisition, retry policy, and timeout behavior.
- [LLM streaming subsystem](subsystems/llm-streaming.md) defines provider-neutral request scheduling metadata.
- [Local inference scheduling Agent Note](../.agents/notes/implemented/architecture/2026-09-29-local-inference-scheduling-metadata.md) records the architectural decision and its consequences.
- [`dsh-serve`](../tools/dsh-serve/dsh-serve) is the shared enforcement point for DSH, Fleet, and compatibility clients.

The archive is deployment research, not a promise that every measured parameter is portable. Context capacity, KV-cache fit, concurrency, time to first token, and throughput depend on the model build, vLLM version, GPU, and launch profile identified by each report.

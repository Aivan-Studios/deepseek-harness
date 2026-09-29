# 本地 Qwen 与 Lean harness 研究

[English](local-qwen-research.md) | 中文

本文档用于定位本仓库本地 Qwen 部署所依据的证据。研究范围包括 Lean preset 与 persona、提示词及工具 schema 成本、与 Claude Code 的对比、长上下文与输出上限行为、代理故障处理，以及 DSH 和 Fleet 共用的推理准入机制。

版本化的[研究档案](../research/local-qwen/index.md)保留了完整工作文档和基准结论。这些记录解释了部署为何采用 pi-ai adapter、`dsh-serve` TCP 到 UDS 代理、模型不可见的调度元数据和两阶段准入许可。

当前运行时约定仍由各自所属文档定义：

- [pi-ai adapter README](../packages/llm/llm-pi-ai/README.zh.md)定义提供方配置、调度 header、许可获取、重试策略和超时行为。
- [LLM 流式子系统](subsystems/llm-streaming.zh.md)定义提供方无关的请求调度元数据。
- [本地推理调度 Agent Note](../.agents/notes/implemented/architecture/2026-09-29-local-inference-scheduling-metadata.zh.md)记录架构决策及其后果。
- [`dsh-serve`](../tools/dsh-serve/dsh-serve)是 DSH、Fleet 和兼容客户端共用的执行点。

该档案属于部署研究，并不承诺所有测得参数都可移植。上下文容量、KV cache 适配、并发数、首 token 延迟和吞吐量取决于各报告标识的模型构建、vLLM 版本、GPU 和启动 profile。

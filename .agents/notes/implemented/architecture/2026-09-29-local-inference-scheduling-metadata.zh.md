# Agent Note: 本地推理调度元数据

Status: implemented

[English](2026-09-29-local-inference-scheduling-metadata.md) | 中文

## Problem

本地 Qwen proxy 会接收来自独立 agent 会话、辅助模型调用和 Claude 兼容客户端的请求，但原始 OpenAI 与 Anthropic 请求不携带持久的调度意图。vLLM 可以批处理和排队，却无法区分 operator turn、标题请求和 background 工作。若对所有 pi-ai 路由统一添加本地标头，部署策略会泄漏给远程提供方。

## Decision

`GenerateOptions.scheduling` 携带模型不可见的 class、tenant、purpose、request id 和 queue deadline 元数据。`AgentOptions.scheduling` 把该意图应用到每个会话请求，但不会把它加入模型可见的持久 session log。

pi-ai adapter 仅在 provider profile 设置 `schedulingHeaders: true` 时传输调度元数据。显式元数据优先。否则，启用该设置的路由会把会话标题归为 background、compaction 归为 agent，并把普通的 session-bound 调用归为 agent，以其 session id 作为公平调度 tenant。未启用的路由不发送调度标头。

loopback `dsh-serve` proxy 会验证有限的 class 集合与有界标头值，在写日志前对 tenant 值做哈希，并在转发至 vLLM 前移除所有 `X-Aivan-*` 字段。Phase 1 shadow counter 会记录按实测的 2 个 active request 策略，每个生成请求将被 admit 还是 queue，但不会延迟或拒绝请求。token counting endpoint 不进入生成计数器，因为它不分配生成 slot 或 KV sequence。现有 Claude auto-mode permission classifier 被识别为有界 control 工作；其他未标记客户端采用 `agent/legacy` 语义。

loopback pi-ai profile 上的 `admission: true` 会在构建提供方 stream watchdog 前获取 proxy permit。该 permit 不透明、只能使用一次、绑定 class、tenant 与 request id，并在五秒内未被消费时失效。Phase 2 只对 background 工作强制 2 个 active request 与每 tenant 1 个 background request 的限制；其他 class 参与 active 计数，但在 weighted fairness 验证完成前仍直接通过。queue expiry、queue capacity、permit mismatch 与 permit reuse 会返回稳定的 `ADMISSION_*` failure，本地路由的 retry policy 不会盲目重试这些 failure。

## Alternatives considered

- **把调度字段放入 pi-ai 的提供方专用选项**——否决，因为 initiator 和 agent loop 拥有意图，adapter 拥有传输。
- **对所有 pi-ai 路由启用标头**——否决，因为本地 admission 元数据不得到达远程提供方。
- **通过检查 prompt 对所有请求分类**——否决，因为 prompt 启发式规则不是稳定的意图约定；只有现有 classifier 签名具备独立的有界 control 要求。
- **立即强制 2 个 request 的上限**——否决，因为 Phase 1 必须先审计分类与 shadow decision，再改变请求时序。

## Consequences

本地 DSH 流量可以按 class 和有界 tenant 身份审计，无需向日志或 vLLM 暴露 prompt 或 tenant 名称。当前 Claude 兼容 Fleet 会话仍是 legacy agent 流量；在其 runtime adapter 提供显式的逐 turn 元数据前，只有已知 control classifier 例外。Shadow active count 描述生成请求到达时的并发量，而不是仅执行 tokenizer 的调用或 vLLM KV fit，也不替代引擎 scheduler。

DSH-aware 调用会在提供方 idle timing 开始前等待，而 compatibility client 会在其 HTTP request 内等待。排队客户端断开会取消等待，acquire response 丢失会撤销 reservation。仅对 background 强制限制降低了 Phase 2 的风险，但允许非 background 负载超过两个 active request；Phase 3 会通过 weighted fairness 与 ageing 关闭这一刻意保留的缺口。

# Agent Note: 本地推理调度元数据

Status: implemented

[English](2026-09-29-local-inference-scheduling-metadata.md) | 中文

## Problem

本地 Qwen proxy 会接收来自独立 agent 会话、辅助模型调用和 Claude 兼容客户端的请求，但原始 OpenAI 与 Anthropic 请求不携带持久的调度意图。vLLM 可以批处理和排队，却无法区分 operator turn、标题请求和 background 工作。若对所有 pi-ai 路由统一添加本地标头，部署策略会泄漏给远程提供方。

## Decision

`GenerateOptions.scheduling` 携带模型不可见的 class、tenant、purpose、request id 和 queue deadline 元数据。`AgentOptions.scheduling` 把该意图应用到每个会话请求，但不会把它加入模型可见的持久 session log。

pi-ai adapter 仅在 provider profile 设置 `schedulingHeaders: true` 时传输调度元数据。显式元数据优先。否则，启用该设置的路由会把会话标题归为 background、compaction 归为 agent，并把普通的 session-bound 调用归为 agent，以其 session id 作为公平调度 tenant。未启用的路由不发送调度标头。

loopback `dsh-serve` proxy 会验证有限的 class 集合与有界标头值，在写日志前对 tenant 值做哈希，并在转发至 vLLM 前移除所有 `X-Aivan-*` 字段。Phase 1 shadow counter 会记录按实测的 2 个 active request 策略，每个生成请求将被 admit 还是 queue，但不会延迟或拒绝请求。token counting endpoint 不进入生成计数器，因为它不分配生成 slot 或 KV sequence。现有 Claude auto-mode permission classifier 被识别为有界 control 工作；其他未标记客户端采用 `agent/legacy` 语义。

loopback pi-ai profile 上的 `admission: true` 会在构建提供方 stream watchdog 前获取 proxy permit。该 permit 不透明、只能使用一次、绑定 class、tenant 与 request id，并在五秒内未被消费时失效。proxy 最多准入两个生成请求，使用平滑加权服务份额选择排队 class，提升等待过久的 background 和 agent 工作，在选中的 class 内轮换 tenant，并保留每 tenant 最多一个 active background request 的限制。queue expiry、queue capacity、permit mismatch 与 permit reuse 会返回稳定的 `ADMISSION_*` failure，本地路由的 retry policy 不会盲目重试这些 failure。`GET /_aivan/admission/status` 会报告有界聚合的 active、queue、body byte、最久等待和 permit 状态，不暴露 tenant 或 request 标识符。

对同一 tenant 与 request id，permit 获取是幂等的。并发重复请求只共享一个 queue entry；若 permit 发出后的 acquire response 丢失，客户端可重试一次并取回同一个仍然有效的 token。若用不同调度元数据复用该身份，或其 permit 已被模型请求消费但请求仍在执行，proxy 会直接失败，不再分配 capacity。这个 retry 仅限于生成开始前的 acquire transport loss；overload、protocol error 和模型生成不会由此机制重试。

admission 还会预留保守的 estimated-token budget。纯文本 DSH 调用会发送根据 UTF-8 byte 推导的 input estimate 以及请求的 output cap；compatibility 调用则从完整 request body 推导同样有界的估值。active request 仍最多为两个，且其聚合 reservation 不得超过 130K token；唯一例外是单个更大的 request 可以独占运行。较小的 control 工作可以利用大型 request 旁的剩余 headroom。排队 request 因 token fit 最多被绕过八次；达到上限后会暂停非 control backfill，避免连续的小工作让它饥饿。这是经实测校准的 admission headroom，并不替代 vLLM 的权威 KV allocator。

## Alternatives considered

- **把调度字段放入 pi-ai 的提供方专用选项**——否决，因为 initiator 和 agent loop 拥有意图，adapter 拥有传输。
- **对所有 pi-ai 路由启用标头**——否决，因为本地 admission 元数据不得到达远程提供方。
- **通过检查 prompt 对所有请求分类**——否决，因为 prompt 启发式规则不是稳定的意图约定；只有现有 classifier 签名具备独立的有界 control 要求。
- **立即强制 2 个 request 的上限**——否决，因为 Phase 1 必须先审计分类与 shadow decision，再改变请求时序。

## Consequences

本地 DSH 流量可以按 class 和有界 tenant 身份审计，无需向日志或 vLLM 暴露 prompt 或 tenant 名称。启用 loopback 调度 bridge 后，Claude 兼容 Fleet 会话会携带显式的逐 turn 元数据；未标记的 compatibility client 保留安全的 `agent/legacy` 语义。Shadow active count 描述生成请求到达时的并发量，而不是仅执行 tokenizer 的调用或 vLLM KV fit，也不替代引擎 scheduler。

DSH-aware 调用会在提供方 idle timing 开始前等待，而 compatibility client 会在其 HTTP request 内等待。排队客户端断开会取消等待。permit 一旦发出，acquire response 丢失时会保留这个短期 reservation，让使用同一 ID 的 retry 取回它；若未取回，expiry 会释放 permit。proxy 会保持 vLLM 内部 queue 较浅；vLLM 仍拥有 KV allocation、batching、token scheduling 和 generation。

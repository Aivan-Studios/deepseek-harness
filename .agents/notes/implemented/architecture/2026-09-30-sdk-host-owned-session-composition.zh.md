# Agent Note: SDK 宿主持有的会话组合

Status: implemented

[English](2026-09-30-sdk-host-owned-session-composition.md) | 中文

## Problem

嵌入宿主可以向 DSH agent 排入提示词并观察事件，却无法保留宿主持有会话的其余约定。运行时自行选择组合，只在提示词到来时顺带创建会话，没有恢复或取消操作，也无法执行宿主持有的工具，或把组合策略产生的审批请求交还宿主。因此，携带身份、任务上下文、协调工具与持久会话 id 的宿主只能丢弃这些义务，或绕开 DSH agent 组合。

完整 persona 会放大静默丢失的风险：在根提示词层追加调用方文本，不能证明 agent 作用域的完整 persona 真正渲染了它。工具审批存在相反的所有权问题：DSH 策略知道调用为何需要审批，嵌入宿主持有人类审批通道，也需要原始工具参数来展示请求。

## Decision

SDK 初始化约定接受 `agentPreset`、`systemPromptAppend`、`hostTools` 与 `hostToolGate`。会话 setup 在 agent 作用域内挂载所选 preset，注册 `sdk_system_prompt_append` 与调用方工具，然后渲染最终提示词。若提供的 append 不在渲染结果中，会话创建会失败。完整 persona 通过 `{{sdk_system_prompt_append}}` 显式接入；调用方身份与任务上下文不会因 preset 优先级而消失。

调用方工具 schema 由 DSH 支持的对象根 JSON Schema 校验器验证，并作为普通的作用域 `ToolDefinition` 注册。执行通过现有双向 JSON-RPC 传输的 `host/tool-execute` 返回宿主，取得规范文本结果，并沿用工具执行的取消信号。重复名称与不支持的 schema 会拒绝初始化。

启用 `hostToolGate` 后，前置的作用域 `tools/pre-execute` listener 会先运行组合策略链。`allow` 与 `deny` 保持不变；`ask` 会转换为 `host/tool-gate` 请求，携带会话 id、工具名称、冻结参数与策略原因。宿主返回允许或拒绝，因此 DSH 继续持有分类逻辑，嵌入应用持有审批交互。

`session/open` 在首个提示词之前显式创建或恢复稳定会话。`session/cancel` 协作式取消活动与排队工作，但不 dispose 会话。TypeScript 与 Python 客户端都投射这些方法；TypeScript 客户端还投射具名的宿主执行与审批 handler，Python 则保留通用入站请求应答接口。

## Alternatives considered

**把宿主身份与工具放入独立自定义 `cordis.yml`。** 这会把逐会话状态复制到进程配置中，无法安全地按调用方会话变化，也无法让宿主协调 callback 参与工具执行。

**在所选 preset 外追加调用方上下文。** 完整 persona 可以替换其他系统提示词 section，因此启动成功不能证明模型收到调用方约定。渲染并验证原值可把这种歧义变成启动失败。

**让宿主在 DSH 策略之前审批每个工具。** 宿主将不得不复制 DSH 策略，并会为组合策略本可直接允许或拒绝的调用发起询问。只处理下游 `ask` 决策，可保留一个分类方和一个人类交互所有者。

**用进程关闭代替中断，并在提示词到来时隐式创建恢复会话。** 进程关闭会丢弃可复用运行时中的所有会话，也无法在接受工作前识别过期持久 id。显式 open 与 cancel 保留进程所有权，并使恢复拒绝可观察。

## Consequences

嵌入应用可以把 DSH 作为真正的会话运行时，而不丢弃调用方身份、协调工具、审批路由、取消或持久恢复。Preset 仍是组合权威；不兼容的完整 persona 会在首个提示词前失败。双向宿主调用要求客户端在轮次活动期间持续读取并响应 JSON-RPC；放弃这些请求可能阻塞对应工具执行。取消仍为协作式，协议仍没有逐会话关闭操作。

协议、TypeScript 客户端与 Python 客户端测试无需凭据即可覆盖新请求形状与生命周期操作。服务器测试覆盖宿主工具校验。一次本地模型实机 smoke 还通过 stdio 运行时执行 preset 挂载、作用域注册与经验证的提示词插入；该设备相关检查属于部署证据，不是仓库必需 gate。

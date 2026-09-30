# Agent Note: SDK host-owned session composition

Status: implemented

English | [中文](2026-09-30-sdk-host-owned-session-composition.zh.md)

## Problem

An embedding host could enqueue prompts and observe a DSH agent, but it could not preserve the rest of an owned session contract. The runtime selected its own composition, created sessions only as a prompt side effect, offered no resume or cancellation operation, and could not execute host-owned tools or return composed approval asks. A host that carried identity, task context, coordination tools, and durable session ids therefore had to discard those obligations or bypass DSH's agent composition.

Complete personas made silent loss especially dangerous: appending caller text at a root prompt layer did not prove that an agent-scoped complete persona rendered it. Tool approval had the inverse ownership problem: DSH policy knew why a call required approval, while the embedding host owned the human approval channel and the original tool arguments needed to present it.

## Decision

The SDK initialization contract accepts `agentPreset`, `systemPromptAppend`, `hostTools`, and `hostToolGate`. Session setup mounts the selected preset inside the agent scope, registers `sdk_system_prompt_append`, registers caller-owned tools, then renders the resulting prompt. A supplied append that is absent from the rendered prompt rejects session creation. Complete personas opt in explicitly with `{{sdk_system_prompt_append}}`; caller identity and task context cannot disappear behind preset precedence.

Caller-owned tool schemas are validated with DSH's supported object-rooted JSON Schema validator and registered as ordinary scoped `ToolDefinition` values. Execution crosses the existing bidirectional JSON-RPC transport through `host/tool-execute`, returns canonical text, and follows the tool execution's cancellation signal. Duplicate names and unsupported schemas reject initialization.

When `hostToolGate` is enabled, a prepended scoped `tools/pre-execute` listener runs the composed policy chain first. It leaves `allow` and `deny` unchanged; an `ask` becomes a `host/tool-gate` request carrying session id, tool name, frozen arguments, and policy reason. The host returns allow or deny, so DSH continues to own classification while the embedding application owns the approval interaction.

`session/open` explicitly creates or resumes a stable session before its first prompt. `session/cancel` cooperatively cancels active and queued work without disposing the session. The TypeScript and Python clients project these methods; the TypeScript client also projects typed host execution and gate handlers, while Python retains its general incoming-request responder.

## Alternatives considered

**Put host identity and tools in a custom standalone `cordis.yml`.** This duplicates per-session state into process configuration, cannot vary safely by caller session, and makes the host's coordination callbacks unavailable to tool execution.

**Append caller context outside the selected preset.** A complete persona can replace other system-prompt sections, so successful startup would not prove that the model received the caller contract. Rendering and exact-value verification turns that ambiguity into a startup failure.

**Let the host gate every tool before DSH policy.** The host would have to duplicate DSH's policy and would prompt for calls that the composed policy allows or denies directly. Resolving only downstream `ask` decisions preserves one classifier and one human interaction owner.

**Use process shutdown for interruption and lazy prompt-time creation for resume.** Process shutdown discards every session in a reusable runtime and cannot distinguish a stale durable id before accepting work. Explicit open and cancel preserve process ownership and make resume refusal observable.

## Consequences

Embedding applications can use DSH as their real session runtime without discarding caller identity, coordination tools, approval routing, cancellation, or durable resume. Presets remain the composition authority, and an incompatible complete persona fails before the first prompt. Bidirectional host calls mean a client must continue reading and answering JSON-RPC while a turn is active; abandoning those requests can block the corresponding tool execution. Cancellation remains cooperative, and the wire still has no per-session close operation.

The protocol, TypeScript client, and Python client tests cover the new request shapes and lifecycle operations without credentials. Server tests cover host-tool validation. A live local-model smoke additionally exercises preset mounting, scoped registration, and verified prompt insertion through the stdio runtime; this device-dependent check is deployment evidence rather than a required repository gate.

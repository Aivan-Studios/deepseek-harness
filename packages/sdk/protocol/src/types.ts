/**
 * Named wire types for the DeepSeek Harness SDK runtime protocol: the three
 * request/result pairs and the four server-to-client notification payloads
 * exchanged over the newline-delimited JSON-RPC stdio transport. The server
 * plugin (`@deepseek-ai/dsh-sdk-jsonrpc-server`) and SDK clients share these shapes;
 * `serverInfo.name` stays the wire-stable `deepseek-harness-sdk-runtime`.
 *
 * @module @deepseek-ai/dsh-sdk-protocol/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'

/** Parameters for the process-wide SDK handshake. */
export interface InitializeParams {
  /** Working directory recorded on every SDK-created session's header. */
  cwd: string
  /** Provider route every SDK-created agent runs on. */
  provider: string
  /** Model name every SDK-created agent runs on (the server may mount a fallback adapter; see `HarnessSdkJsonRpcServer.initialize`). */
  model: string
  /** Optional positive output-token cap inherited by SDK-created agents and their in-process descendants. */
  maxTokens?: number
  /** Optional agent preset composed into every SDK-owned session. */
  agentPreset?: string
  /**
   * Per-process caller context interpolated through the
   * `sdk_system_prompt_append` system-prompt variable. A selected preset must
   * render the complete value; initialization of the first session fails if it
   * does not, so identity or task context cannot be dropped silently.
   */
  systemPromptAppend?: string
  /** Caller-owned tools registered in every SDK-owned session. */
  hostTools?: HostToolDefinition[]
  /** Route composed tool `ask` decisions back to the embedding host. */
  hostToolGate?: boolean
}

/** One caller-owned tool whose execution crosses back over JSON-RPC. */
export interface HostToolDefinition {
  /** Model-facing tool name, unique within the composed session. */
  name: string
  /** Model-facing description. */
  description: string
  /** Supported object-rooted JSON Schema for model arguments. */
  parameters: Record<string, unknown>
}

/** Wire-stable server identity returned by initialization. */
export interface InitializeResult {
  /** Wire-stable server identity (`deepseek-harness-sdk-runtime`) and version. */
  serverInfo: { name: string; version: string }
}

/** One user turn on one SDK session. */
export interface SessionPromptParams {
  /** The SDK-side session id; an unknown id lazily creates the agent+session pair. */
  sessionId: string
  /** The prompt content blocks, sent verbatim as the user message. */
  contentBlocks: ContentBlock[]
}

/** Durable enqueue receipt for one prompt. */
export interface SessionPromptResult {
  /** Identity of the queued user message. */
  messageId: string
}

/** Create or resume one SDK-owned session before its first prompt. */
export interface SessionOpenParams {
  /** Stable session identity. */
  sessionId: string
  /** Resume the persisted session instead of creating a fresh one. */
  resume?: boolean
}

/** Confirmed live session identity. */
export interface SessionOpenResult {
  sessionId: string
}

/** Cancel active and queued work for one live SDK-owned session. */
export interface SessionCancelParams {
  sessionId: string
}

/** Cancellation receipt; `active` is false for an unknown session. */
export interface SessionCancelResult {
  active: boolean
}

/** Server-to-client execution request for one caller-owned tool. */
export interface HostToolExecuteParams {
  sessionId: string
  name: string
  arguments: Record<string, unknown>
}

/** Canonical text returned to the model for a caller-owned tool. */
export interface HostToolExecuteResult {
  text: string
}

/** One composed DSH tool policy asking the embedding host for approval. */
export interface HostToolGateParams {
  sessionId: string
  name: string
  arguments: Record<string, unknown>
  reason?: string
}

/** Host verdict for a gated DSH tool call. */
export type HostToolGateResult =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string }

/** Deployment-mapped SDK outcome: `ok` for an accepted result, `error` otherwise. */
export type SdkRunStatus = 'ok' | 'error'

/** `session.event` payload: one session-log event, streamed as it is recorded. */
export interface SessionEventNotification {
  /** Session the event belongs to (every session in the runtime, not only SDK-created ones). */
  sessionId: string
  /** The full session-log event envelope. */
  event: SessionEvent
}

/** Whole-agent lifecycle state for one session. */
export interface SessionStatusNotification {
  /** Session whose live agent changed status. */
  sessionId: string
  /** The whole-agent state after the transition. */
  status: 'idle' | 'running'
}

/** `subagent.started` payload: an in-runtime child session was created. */
export interface SubagentStartedNotification {
  /** The delegating session. */
  parentSessionId: string
  /** The new child session. */
  childSessionId: string
}

/** `subagent.finished` payload: an in-process subagent run ended (remote runs are not reported). */
export interface SubagentFinishedNotification {
  /** Subagent provider name that ran the child. */
  provider: string
  /** The child agent's id (equals {@link childSessionId} for local runs). */
  agentId: string
  /** The delegating session. */
  parentSessionId: string
  /** The child session. */
  childSessionId: string
  /** Deployment-mapped run outcome. */
  status: SdkRunStatus
  /** The provider-reported stop reason. */
  stopReason: SubagentStopReason
  /** The child's selected assistant output; absent when the child produced none. */
  lastAssistantMessage?: ContentBlock[]
}

/** Server-to-client notifications by JSON-RPC method name. */
export interface HarnessSdkNotificationMap {
  'session.event': SessionEventNotification
  'session.status': SessionStatusNotification
  'subagent.started': SubagentStartedNotification
  'subagent.finished': SubagentFinishedNotification
}

/** Client-to-server request methods with their param and result shapes. */
export interface HarnessSdkRequestMap {
  'initialize': { params: InitializeParams; result: InitializeResult }
  'session/open': { params: SessionOpenParams; result: SessionOpenResult }
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult }
  'session/cancel': { params: SessionCancelParams; result: SessionCancelResult }
  'shutdown': { params: undefined; result: Record<string, never> }
}

/** Runtime-to-client requests served by an embedding host. */
export interface HarnessSdkHostRequestMap {
  'host/tool-execute': { params: HostToolExecuteParams; result: HostToolExecuteResult }
  'host/tool-gate': { params: HostToolGateParams; result: HostToolGateResult }
}

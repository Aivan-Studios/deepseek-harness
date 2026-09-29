# DeepSeek Harness plugins for a lean local Qwen setup

Research date: 2026-09-23.

Companion to [the Lean Qwen harness design](harness-design.md).
Discovery started at the [GitHub dsh-plugin topic](https://github.com/topics/dsh-plugin); the descriptions below were checked against repository documentation.

## Main finding

Because Qwen is already launched through DeepSeek Harness (DSH), a lean DSH preset is worth evaluating before building the proposed separate Python harness. Existing presets and plugins cover substantial parts of Phase 1 (lower startup context) and Phase 2 (indexed retrieval).

These are documentation findings, not runtime verification. Compatibility with the installed DSH version, actual Qwen token counts, and task performance remain unmeasured. The original plan's estimated Claude Code floor is not a measurement of the current DSH setup.

## Official baseline: Minimal preset

[Official Minimal preset source](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/config/agent-presets/minimal/agent.cordis.yml)

DSH ships a Minimal preset with:

- Persistent `bash` and `str_replace_editor`.
- A fixed short system prompt.
- Runtime context snapshots suppressed.
- No context compaction.

This already addresses much of Phase 1's intended reduction. It is an official preset, not a community plugin.

## Community presets and tool-schema reduction

| Project | What it provides | Relevance and limitations |
|---|---|---|
| [Canson666/dsh-minimal-tools-preset](https://github.com/Canson666/dsh-minimal-tools-preset) | Minimal core plus selectable packs for file search, web search, skills, planning and code review. | Starting point for assembling only the capabilities Qwen needs. Added packs still need their context costs measured. |
| [mikeyoubeach/dsh-minimal-v3](https://github.com/mikeyoubeach/dsh-minimal-v3) | Fixed minimal prompt; nine tools for shell, files, search, user questions and todos. No automatic instruction injection or compaction. Uses bash on Linux/macOS and PowerShell on Windows. | More everyday coding functionality than the official two-tool preset. Author reports verification against DSH 0.1.0-rc.6 with DeepSeek models; this is not Qwen validation. |
| [studyzy/dsh-lazy-tools](https://github.com/studyzy/dsh-lazy-tools) | Hides selected tool schemas until discovery/activation through `tool_search` or `defer_execute_tool`. Supports always-visible exceptions. Activated tools become directly callable. | Directly targets startup tool overhead while retaining optional capabilities. Provider independent by design; it controls visibility rather than executing tools itself. |
| [wings1848/dsh-mcp-lazy](https://github.com/wings1848/dsh-mcp-lazy) | One stable MCP gateway tool, on-demand schema discovery, lazy server startup, idle shutdown and cached metadata. | Useful when MCP schemas are a substantial part of the floor. Author reports 92.8% schema reduction for a 29-tool chrome-devtools-mcp example, estimated from serialized bytes at four bytes per token. This is not Qwen tokenizer measurement or a whole-session saving. Small tool collections may not benefit. |

The specific owner matters for `dsh-mcp-lazy`: multiple similarly named projects appeared in search.

## Code indexing and project retrieval

| Project | Retrieval method | Relevance and limitations |
|---|---|---|
| [lemonxiny55/dsh-code-index](https://github.com/lemonxiny55/dsh-code-index) | Local tree-sitter symbols, lexical search, repository maps, call graphs, change context and bounded task context. Incremental on-disk index. | Strong Phase 2 candidate. Experimental `toolSurface: compact` exposes `code_index` and `code_context`, plus `code_health` only if enabled. `autoInject: false` disables the standing repository map. No embedding service or API key needed for indexing. |
| [CC19990113/dsh-plugin-codegraph](https://github.com/CC19990113/dsh-plugin-codegraph) | Structural index for symbol search, callers, callees, impact, tracing, status and task context. | Two tools: `codegraph` and `codegraph_index`. Index construction is explicit; queries do not silently build an index. A close fit for the design's small query/status interface. |
| [00080000/dsh-project-memory](https://github.com/00080000/dsh-project-memory) | BM25 retrieval over documents, code symbols and experience notes, with source citations and incremental refresh. Files can be indexed when read. | Useful for knowledge spanning documentation and code. No vector embeddings. Its broader task/memory features and automatic context injection add scope and require overhead measurement. Indexing is model-free; optional LLM query expansion is off by default. |

Structural and lexical indexing can reduce repeated exploratory reads without running an embedding model. Their usefulness on the actual repositories still needs comparison with grep-and-read.

## Embedding-based persistent memory

### memsearch

Repository: [zilliztech/memsearch](https://github.com/zilliztech/memsearch)

DSH package: `@zilliz/memsearch-dsh`.

- Persistent memory backed by Markdown and Milvus.
- Default embeddings use local CPU ONNX `bge-m3`; the documented initial model download is approximately 558 MB.
- Ollama and other embedding providers are supported.
- Milvus Lite provides a local single-file backend by default.
- The DSH integration captures completed turns and injects relevant memories before the first model step when useful.

A genuine embedding option for recalling previous work. Its documented DSH role is conversation memory; it serves a different purpose from a structural code index.

### dsh-mneme

Repository: [slow-stack/dsh-mneme](https://github.com/slow-stack/dsh-mneme)

DSH package: `@modusensus/dsh-mneme`.

Provides cross-session Markdown memory, semantic retrieval and consolidation. Local embeddings are supported. The repository README contradicts itself about the default: its prose claims offline defaults, while its configuration table lists `embedProvider: openai` and instructs users to select `local`. Verify configuration before evaluating it as an offline solution.

### YAPA — broader alternative

Repository: [vuldin/yapa](https://github.com/vuldin/yapa)

Native DSH integration supplies persistent memory, task management, automatic recall/capture and an embedded storage option. The README lists 23 default tools plus 18 gated ML-ops tools. It is related to the memory goal, but its broad tool surface makes it a less obvious first choice for minimizing startup context.

## Recommended first experiment

1. Measure the existing Qwen/DSH startup request with the local tokenizer.
2. Compare the official Minimal preset or a small custom DSH preset.
3. Add `dsh-code-index` with `toolSurface: compact`, `autoInject: false`, and code health disabled. Its documented compact surface then consists of two tools.
4. Compare that with `dsh-plugin-codegraph` if structural queries are the main use case.
5. Add lazy tool loading only if retaining a larger optional catalog. Consider the MCP gateway specifically when MCP schemas dominate the overhead.
6. Evaluate embedding memory separately if cross-session recall is needed.

This is a proposed evaluation sequence, not a tested combination. A preset's complete fixed persona may also affect prompt injection from other plugins; inspect the composed request instead of assuming all integrations behave identically under Minimal.

Keep the original design's measurement discipline: a predefined task set, correctness plus context consumption, and actual local-tokenizer accounting. None of these findings establishes that the 3.5–5k startup target has been reached, or that the original safety and handoff requirements are fully covered.

## Work performed

Searched the topic and ecosystem, then read repository documentation. No plugins were installed and no local DSH configuration was changed.

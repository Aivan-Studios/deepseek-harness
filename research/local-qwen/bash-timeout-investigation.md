The evidence points to a classifier latency problem, aggravated by a Qwen/vLLM thinking-control mismatch. Box
  contention is not required.

  I checked qwen_lean_harness, its transcripts, the classifier error dump, and vLLM logs:

  • Failures occur without contention. I found 32 timeout results whose corresponding server-log samples showed at
    most one running request and zero waiting. For example, today at 11:43:10 Helsinki time, classification failed
    after 70.76 seconds; the seven samples during that interval showed one running request, no queue, and only
    about 19–23% KV-cache usage. That contradicts the earlier cache-saturation explanation. Server log (/home/
    ville/.local/state/dsh-serve/server.log:91332)

  • The classifier is a substantial extra model call. One captured failure approving a simple find command
    contained 135,051 characters—an estimated 33,763 tokens. It ended with Request was aborted. Current subagent
    failures frequently return after roughly 61 seconds, consistent with a classifier deadline rather than Bash
    timing out. Error dump (/home/ville/.claude/projects/-home-ville-claude-qwen/9b7efac5-872e-43fd-9c11-
    d40d2e09a15b/auto-mode-classifier-error.txt:1)

  • Every model alias uses the same 27B model. The launcher routes even “small/fast” requests to Qwen. There is no
    separate fast classifier backend. Launcher (/home/ville/bin/claude-qwen:8)

  • Disabling thinking through Anthropic’s API doesn’t work in this installed adapter. I verified offline that
    thinking: {"type":"disabled"} is silently discarded. Meanwhile, the model’s template enables thinking by
    default. The adapter accepts chat_template_kwargs, which is the relevant Qwen control. Installed adapter
    (/home/ville/.venvs/vllm/lib/python3.12/site-packages/vllm/entrypoints/anthropic/protocol.py:119), model
    template (/home/ville/models/Qwen3.8-27B-NVFP4/chat_template.jinja:178), vLLM documentation
    (https://docs.vllm.ai/en/latest/features/reasoning_outputs/)

  The resulting failure mechanism is: large classification prompt → local reasoning generation → no completed
  verdict before the deadline → denied tool call → agent retries.

  The timeout and lack of contention are established. Unwanted thinking is a verified compatibility defect and a
  strong explanation for excessive classification time, but proving its exact contribution requires capturing a
  classifier request and replaying it with thinking explicitly disabled.

  The active session also has three background agents, so its current queue adds further delay. That explains
  amplification, not the single-request failures.

  The targeted next fix to validate is honoring thinking controls for classifier requests while retaining reasoning
  for normal agent work. Increasing Bash’s command timeout would not address this. I haven’t changed settings or
  interrupted the session.

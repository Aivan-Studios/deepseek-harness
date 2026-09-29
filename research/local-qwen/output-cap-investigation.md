# Output-cap investigation — 2026-09-19

Question: does the launcher's 24,000-token default reflect a finding that it
works better than the 16,000-token configured cap?

## Finding

No local record was found that validates 24k or explains an intentional change
from 16k to 24k.

The only 24k reference specific to Claude Code is the fallback in
`/home/ville/bin/claude-qwen`:

```bash
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-24000}"
```

The operational guide and `~/.claude/settings.json` both identify 16,000 as
the configured/current cap. The guide documents a 128k (131,072-token) vLLM
hard limit that covers input plus requested output.

## Relevant later evidence

The project memory `local-vllm-classifier-contention.md`, modified 2026-09-19,
reports that a 16k generation with roughly 90k context can starve concurrent
permission-classifier calls on the shared local vLLM. Its recommended
mitigation is to lower the cap from 16k to 8k under contention, not to raise it.

## Consequence

If the effective cap is 24k, the maximum input which can be paired with that
requested output without exceeding 131,072 is 107,072 tokens. With a 16k cap,
it is 115,072 tokens. In either case, the guide's 90k/100k clear thresholds
remain useful safeguards; the cap is only a backstop.

## Timing and unresolved point

The launcher was modified at 2026-09-18 14:16 EEST, after the settings file
(12:40) and `CLAUDE.md` (12:38). That ordering could indicate a later launcher
change, but no rationale was found. It also does not establish which value
Claude Code ultimately applies when the launcher exports 24k and its settings
declare 16k. Verify the effective value in a newly launched `claude-qwen`
session before treating either number as authoritative.

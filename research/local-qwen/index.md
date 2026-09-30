# Local Qwen research archive

This directory preserves the design records, benchmark conclusions, operational investigations, and chronological notes used to build the Lean Qwen configuration and local inference admission system. These files are historical research evidence rather than the current package contract; current behavior remains documented by package READMEs, subsystem references, and Agent Notes.

## Lean harness design

- [Harness design](harness-design.md)
- [Persona draft](persona-draft.md)
- [DSH plugin findings](plugin-findings.md)
- [Output-cap investigation](output-cap-investigation.md)
- [Bash timeout investigation](bash-timeout-investigation.md)
- [Proxy thinking-rewrite handoff](proxy-thinking-rewrite-handoff.md)
- [Chronological research log](research-log.md)

## Comparative evaluation

- [Scenario definitions](ab/scenarios.md)
- [AB2 verdict](ab/ab2-verdict.md) and [score](ab/ab2-score.txt)
- [AB3 containment abort](ab/ab3-aborted.md)
- [AB4 verdict](ab/ab4-verdict.md) and [score](ab/ab4-score.txt)
- [AB5 production-confined verdict](ab/ab5-verdict.md) and [score](ab/ab5-score.txt)

## Shared inference admission

- [Architecture and rollout design](inference-admission-design.md)
- [Benchmark method](admission/benchmark.md)
- [Phase 0 unmanaged baseline](admission/phase0-unmanaged-report.md)
- [Phase 1 DSH shadow audit](admission/phase1-shadow-report.md)
- [Phase 1 Fleet shadow audit](admission/phase1-fleet-shadow-report.md)
- [Phase 2 background-enforcement audit](admission/phase2-background-report.md)
- [Phase 3 full-admission audit](admission/phase3-full-admission-report.md)
- [Phase 3 mixed-context acceptance matrix](admission/phase3-mixed-context-report.md)

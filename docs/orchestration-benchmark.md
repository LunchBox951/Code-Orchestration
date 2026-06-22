# Multi-Level Orchestration Benchmark Runbook

This is the operator guide for the **orchestration benchmark** — the v1 **centerpiece**. Where the
[worker benchmark](worker-benchmark.md) hosts **one** real implementer writing **one** module, the
orchestration benchmark drives the **whole spawn chain** for a scenario:

```
coordinator  →  lead  →  2 implementers  →  merge-up  →  integration branch
```

A real (or, in the deterministic sandbox, a scripted-MCP) **coordinator** receives a general task,
decomposes it into a plan, dispatches a **lead**, the lead fans out **two implementers** who each own a
module, the reviewed implementer branches are **merged up** into the lead's barrel, and the lead's branch
is **merged up** into the coordinator's integration branch. The benchmark then **grades the merged
artifact by executing it** against the scenario's hidden oracle and returns a per-provider
[scorecard](#the-scorecard--metrics-schema).

Everything live runs on the **operator's host machine**, never in CI. The hermetic pieces (the scenario
oracle, the scripted multi-level sandbox harness, and the driver's pure helpers) run automatically under
`pnpm test`.

---

## What it proves (evidence the operator reviews — NOT an auto-checkbox)

A green run is **evidence** an operator reviews, on the v1 ladder; it does not flip any `☑` by itself
(see [`v1-acceptance-criteria.md`](v1-acceptance-criteria.md) and [`v1-handoff.md`](v1-handoff.md)):

- **SH-1** — a real chain produced a working change merged into an integration branch end to end.
- **RL-1** — the coordinator decomposed + dispatched down the chain (orchestration lives in the agent via
  the `co_` tools, never in the daemon; Principle 4).
- **RL-3** — escalations (clarify-timeout forward-ups + watchdog STUCK) are captured per agent.
- **RL-4** — both implementer branches **merged up** through the gated review (the multi-level merge-up).

The grade is **fail-loud and objective**: the oracle **executes** the merged `calc.mjs` (dynamic-import)
and asserts `add/sub/mul/tokenize` over a fixed table. There is no LLM judge — a missing, un-merged, or
wrong module is a hard `correct: false` with a concrete reason (Principle 9).

---

## Sandbox vs host-live — the same honesty bar

The driver (`runOrchestrationBenchmark`) is **one code path** with a switchable **automation seam**; only
the injected seam bundle differs (exactly like the worker benchmark + the `sh1-dry-run` harness):

| | Sandbox (`pnpm test`) | Host-live (`pnpm test:live`) |
| --- | --- | --- |
| pty | `FakePty` | real `NodePtyHost` |
| transport | `InMemoryTransport` | socket-bridge transport |
| clock | injected counter | real (`performance.now`) |
| chain drive | **scripted MCP tool-calls** per agent | a **real provider** self-drives via `serveConductor` |
| fidelity | `sandbox-fake` | `host-live` |

The scorecard's `fidelity` is **derived from the resolved pty host, never from a flag**
(`deriveRunFidelity`): a real `NodePtyHost` ⇒ `host-live`; a `FakePty` ⇒ `sandbox-fake`; anything else
throws (Principle 9). 

> **A green sandbox run is NOT host-live evidence.** The sandbox harness over `FakePty` plays each agent's
> "work" as scripted MCP tool-calls (a real `claude`/`codex` pane can't self-drive in-sandbox). It is the
> deterministic CI regression that the whole multi-level LOOP composes — cold-start → plan → sling → finish
> → gated-merge → merge-up → complete — with zero hand-stitched transitions. It is **structurally barred**
> from being scored `host-live`. The live arm is the only thing that proves a real binary can do the work.

### Honesty note (the unproven half)

The host-live **drive of the full multi-level chain by a real binary is UNPROVEN** — no real provider has
yet self-driven coordinator → lead → 2-implementers → merge-up end to end. `orchestration-benchmark.live.test.ts`
is the harness an operator runs to **generate** that evidence (and to calibrate the timing knobs against a
real binary for the first time). The skip-gate + the derived-fidelity stamp guarantee it can never
mock-pass: without the opt-in / binary / auth / node-pty it **skips loudly** with the reason in its title.

---

## Prerequisites

1. `co` / `co-mcp` built (`pnpm build`; `pnpm test:live` does this for you via `pretest:live`).
2. `node-pty` built for the host (in the `onlyBuiltDependencies` allowlist; a clean install builds the
   native addon). If it is missing, the live cases skip with that reason.
3. The target provider installed and authenticated (Claude: `claude auth status`; Codex: `codex doctor`).
   Each provider's case skips independently when its binary is missing/unauthenticated.

A live run spends **real Anthropic + OpenAI tokens** (it drives many real model turns across the whole
chain). It is gated OFF by default and never runs in CI.

---

## Running it

```sh
pnpm test:live
```

That runs both the worker benchmark **and** the orchestration benchmark against `claude` and `codex`
(Codex parity is the load-bearing unknown — a claude-only pass does not discharge it). Each provider that
is not ready skips loudly.

Each case prints a scorecard (via `renderScorecard`) to stderr, e.g.:

```
orchestration-benchmark calc-lib — PASS (host-live, claude-only)
  run:        calc-lib-ob-claude-…  stop=task-complete
  completed:  true   artifact: true (13/13 cases) — calc.mjs correct: add/sub/mul over 9 cases + tokenize over 4 cases
  merged-up:  2/2 implementer branches
  scores:     correctness=1.00 token-economy=0.87 context-efficiency=0.96
  totals:     turns=… wall=…ms reviews=3 kickbacks=0 escalations=0
  agents:     coordinator×1 lead×1 implementer×2
    - coordinator coord-… [claude]: turns=… wall=…ms esc=0
        tokens=… (in=… out=… cacheR=… cacheC=…) cost=$… econ=0.87 cacheEff=0.74
        tools=… err=0 redundantReads=0 permAsks=0 ctxEff=0.96 [diag: firstCoCall=… tools/task=…]
```

(In a **sandbox** run the `token-economy` column and every raw token field render as `N/A`, not `0` — the
N/A-in-sandbox rule below.)

### Provider-pinning modes

| Mode | What runs the chain |
| --- | --- |
| `claude-only` | the whole chain on `claude` (the reproducible per-provider corpus) |
| `codex-only` | the whole chain on `codex` |
| `mixed` | an operator opt-in (heterogeneous roster; recorded in the scorecard, not auto-run) |

Pin a single provider for a targeted run: `CO_BENCH_ONLY=codex pnpm test:live`.

---

## The scenario + the oracle

The flagship scenario (`calc-lib`, in `packages/core/src/bench/orchestration-scenarios.ts`) builds a small
ES-module calculator library naturally split across a lead and two implementers:

- implementer **`ops`** → `calc-lib/ops.mjs` exporting `add` / `sub` / `mul`;
- implementer **`tokenize`** → `calc-lib/tokenize.mjs` exporting `tokenize(expr)`;
- the **lead** → `calc-lib/calc.mjs`, a barrel that re-exports both after merging the implementer branches
  up.

The oracle (`scenario.evaluate(integrationDir)`) executes `calc-lib/calc.mjs` from a **throwaway worktree
of the integration branch** (never the CO repo, never the live agent worktrees — Principle 12) and checks
`add/sub/mul` over 9 cases + `tokenize` over 4. A missing module (the barrel never merged up), an
un-merged barrel, or a wrong result is a hard `correct: false`. Each implementer carries a
`referenceModule` (what the scripted sandbox implementer writes); a real model authors its own equivalent
from the prompt in live mode — the oracle never reads `referenceModule`, it only executes the merged result.

Add scenarios by extending `ORCHESTRATION_SCENARIOS`: an `OrchestrationScenario` is
`{ id, artifactPath, rootSubject, rootBody, implementers[], lead, evaluate }`.

---

## The scorecard / metrics schema

`runOrchestrationBenchmark` returns an `OrchestrationScorecard` (folded by `summarizeRun`, in
`packages/core/src/bench/orchestration-metrics.ts`). The **hard structural PASS** is objective:

```
pass  =  completed                                  (task.completed recorded in the plan store)
      ∧  artifact.correct                           (the executed oracle passed)
      ∧  implementerBranchesMergedUp ≥ required     (both implementer branches merged up)
      ∧  every merge had ≥ 1 review round           (the gate held)
```

Per-agent and per-merge metrics (the per-provider fine-tuning corpus):

- **`agents[]`** (`AgentRunMetric`) — `agentId`, `role`, `provider`, `turnsUsed`, `wallClockMs`,
  `escalations`, plus the per-agent **`tokenEconomy`** + **`toolEfficiency`** score blocks (below).
  Role/provider come from the roster + dispatch stores; escalations from the mail log.
- **`merges[]`** (`MergeOutcome`) — `branch`, `target`, `reviewRounds`, `kickbacks`, `firstTryPass`,
  `mergeCommitSha`. Rounds are reconstructed from the durable, append-only `review_request` mail log (the
  review store UPSERTs the latest verdict + resets strikes on a PASS, so the mail log is the honest round
  history).
- Totals: `totalTurns`, `totalWallClockMs`, `totalReviewRounds`, `totalKickbacks`, `totalEscalations`,
  `agentsByRole`.
- The merged artifact's oracle tally rides on `artifact.casesPassed` / `artifact.casesTotal` (alongside
  the back-compat binary `artifact.correct`, which is exactly `casesPassed === casesTotal`).

`toJsonl(scorecard)` serialises one record per agent + one run record — an append-only per-provider
corpus. `CO_BENCH_CORPUS_DIR` persists it across runs (else a throwaway dir is used and discarded).

### The three scores (`scorecard.scores` — reported per-run, per-agent, per-role)

Each score is `∈ [0,1]` **or `null` = N/A** (a deliberate "not applicable", **never a silent zero**).
They are independent on purpose: a high token-economy can **never** mask a correctness miss.

| Score | Arms | Definition | Notes |
| --- | --- | --- | --- |
| **CORRECTNESS** | both | `(casesPassed/casesTotal) × (completed?1:0) × clamp01(mergedUp/required) × (everyMergeReviewed?1:0)` | objective; refines the binary oracle into a case fraction, gated by structural completeness |
| **TOKEN-ECONOMY** | **live only** | `clamp01(budgetTokens / max(actualTokens, 1))` | **`null` in the sandbox arm** (`fidelity === 'sandbox-fake'` — no real tokens are spent). Sub-signal `cacheEfficiency = cacheReadTokens / max(cacheReadTokens + cacheCreationTokens, 1)` |
| **CONTEXT/TOOL-EFFICIENCY** | both | `0.4·(1−toolFailRate) + 0.4·(1−redundantReadRate) + 0.2·(1−permissionAskRate)` | `xRate = x / max(toolCalls, 1)`; the weights are **tunable** (`CONTEXT_EFFICIENCY_WEIGHTS`) |

Raw per-agent fields backing the scores: `tokenEconomy.{inputTokens, outputTokens, cacheReadTokens,
cacheCreationTokens, totalTokens, costUsd, tokenEconomy, cacheEfficiency}` (live-only; every field `null`
in the sandbox arm; `costUsd` is `number | null` — `null` where the provider reports no dollar cost) and
`toolEfficiency.{toolCalls, toolErrors, redundantReads, permissionAsks, contextEfficiency}` plus two
**un-scored diagnostics** reported raw: `turnsToFirstProductiveCoCall` (read from the tool-usage rollup) and
`toolCallsPerCompletedTask` (**DERIVED by the driver**, not a store field — `toolCalls / completed-task-count`,
`null` when the run completed no task). `scores` also carries the run-level means + the per-role folds
(`tokenEconomyByRole`, `contextEfficiencyByRole`) for the fine-tuning corpus.

> **N/A-in-sandbox rule (no silent zero), enforced in code:** a sandbox run spends no real tokens, so its
> TOKEN-ECONOMY (and every raw token field) is reported as `null`, NOT `0` — a `0` would falsely read as
> "infinitely wasteful". This is **not** an accident of the cost read-model being absent: the driver
> (`aggregateAgentMetrics` → `readAgentEcon`) takes the run `fidelity` and, when it is `sandbox-fake`,
> **skips the cost read entirely (forces `cost = null`)**, so token-economy is *guaranteed* `null` in the
> sandbox arm even once the live cost surface lands. This is the same silent-zero trap the live `turnsUsed`
> already falls into; the three scores avoid it by design. CONTEXT/TOOL-EFFICIENCY is available in BOTH arms
> (tool calls are observable in the sandbox).

> **Uncalibrated budgets (honest):** the per-scenario token budgets (`BUDGET_TOKENS_BY_SCENARIO`, e.g.
> `calc-lib = 2,000,000`) and the context-efficiency weights were **not** measured against a real binary
> driving the full chain — the first live runs are the calibration. Treat TOKEN-ECONOMY as a relative
> yardstick, not an absolute target, and tune the budgets/weights as the corpus grows. The token/tool raw
> data is read from the conductor's per-agent cost/tool read-model (the `AgentCostRollup` / `AgentToolUsage`
> shapes — owned canonically by the cost/tool-usage PR; the benchmark keeps an *identical bench-local copy*
> and reads the store via **optional chaining**, so it needs no import of those types and `pnpm typecheck`
> stays green whether or not that surface has landed). Until those read-model surfaces land, their
> respective score blocks are `null` (an absent rollup is an honest N/A). Only TOKEN-ECONOMY is live-only;
> CONTEXT/TOOL-EFFICIENCY applies to both arms once the tool-usage rollup exists. A persistent econ-read
> failure is **logged**, never swallowed (Principle 9), so a wedged read surfaces instead of degrading
> invisibly to an all-N/A scorecard.

> **Reconstruction limit (honest):** once a merge lands (a final PASS), the review store keeps only the
> latest verdict and resets the strike counter, so exact historical kickback counts are reconstructed
> from the `review_request` mail log, not the verdict store. `reviewRounds` / `kickbacks` are best-effort
> metrics; the gating fact (`every merge had ≥ 1 review round`) is exact.

---

## Tuning (env overrides)

The host-live timing knobs were never calibrated against a real binary driving the full chain; the first
runs are the calibration. All have safe defaults and are overridable without a code change:

| Env var | Default | Meaning |
| --- | --- | --- |
| `CO_LIVE_E2E` | _unset_ | Set `1` to run the live cases (else they skip loudly). |
| `CO_BENCH_MAX_TICKS` | `64` | Max daemon ticks before giving up. |
| `CO_BENCH_WALLCLOCK_MS` | `1800000` | Overall wall-clock budget per provider. |
| `CO_BENCH_PER_STEP_MS` | `240000` | Per-step (per-tick / per-turn) timeout. |
| `CO_BENCH_CORPUS_DIR` | _unset_ | Persist the per-run JSONL corpus here (else a throwaway dir). |
| `CO_BENCH_ONLY` | _unset_ | Run a single provider (`claude` / `codex`). |
| `CO_BENCH_KEEP` | _unset_ | Set `1` to keep + print the throwaway dirs for a post-mortem. |
| `CO_HOST_LIVE_INJECT_RETRY_MS` | `2000` | Post-inject retry delay (shared with host-proof / worker-benchmark). |
| `CO_HOST_LIVE_READY_SETTLE_MS` | `4000` | Settle after the pane reaches ready (shared). |

---

## Relationship to v1 acceptance criteria

A passing run is **evidence** an operator reviews on the SH-1 / RL-1 / RL-3 / RL-4 ladder — not an
automatic checkbox flip. It exercises the same host-live surface the SH-1 self-host bundle needs (a real
binary reaching ready and routing real mail through a real pty), and unlike a single-agent host-proof it
confirms the **whole chain** can decompose, dispatch, review, and merge up. The per-provider score corpus
supports `PV-1` by comparing the same scenario across Claude/Codex, and its explicit N/A / fail-loud score
semantics provide post-hoc `ST-3` evidence; neither discharges the remaining host-live live-stream
monitoring proof by itself. See
[`sh1-runbook.md`](sh1-runbook.md) for the full self-host evidence bundle and
[`worker-benchmark.md`](worker-benchmark.md) for the single-agent sibling.

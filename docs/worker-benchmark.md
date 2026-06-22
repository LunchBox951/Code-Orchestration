# Live Worker Benchmark Runbook

This is the operator guide for the **live worker benchmark** — the `CO_LIVE_E2E` test that hosts a
**real** `claude` or `codex` implementer in a **real** `node-pty` through CO's real socket-bridge MCP
surface, gives it an actual coding task, lets it work real turns until it signals done, and then
**objectively grades the artifact it produced**.

Where the [host-proof runbook](host-proof.md) proves the host-live _plumbing_ with a scripted
route-proof mail, the worker benchmark proves a real worker can do real work end to end — so the tokens
a host-live run spends also _measure_ the providers. It is the switchable "sandbox → live" half of the
test suite: `pnpm test` runs the hermetic sandbox tests; `pnpm test:live` runs this against the real
binaries on an authenticated host.

Where this grades **one implementer writing one module**, the
[orchestration benchmark](orchestration-benchmark.md) grades the **whole spawn chain** (coordinator → lead
→ 2 implementers → merge-up) — the v1 centerpiece. The two share the same honesty bar (derived fidelity,
objective oracle, skip-loud gate) and the same `CO_BENCH_*` budget knobs.

Everything here runs on the **operator's host machine**, never in CI. The hermetic pieces (the scenario
evaluator and the driver's pure predicates) run automatically under `pnpm test`.

---

## Sandbox vs host-live — the same honesty bar

The benchmark builds its `ConductorEngine` from the **same** `resolveHostLiveSeams` bundle the
host-proof uses (real `NodePtyHost` + socket-bridge transport + real timers), and the scorecard's
`fidelity` is **derived from the resolved pty host, never from the flag** (`deriveProofFidelity`):

- a real `NodePtyHost` ⇒ `fidelity: 'host-live'`;
- anything else throws (Principle 9 — fail-loud).

> **A green sandbox run is not host-live evidence.** `CO_LIVE_E2E` only decides whether the live test
> _runs_. The proof's authenticity is independent of the flag: a misconfigured run that fell back to a
> fake host could never be scored `host-live`. If a required binary is missing, unauthenticated, or
> `node-pty` is not built, the case **skips loudly** with the reason in its title — it never fails and
> never mock-passes (Principle 9).

The objective grade is also fail-loud: the evaluator **executes** the produced module (dynamic-import
of `solution.mjs`) and asserts `add()` over a fixed numeric table. There is no LLM judge — a missing,
wrong, or throwing artifact is a hard `correct: false` with a concrete reason.

---

## Prerequisites

1. `co` / `co-mcp` built (`pnpm build`; `pnpm test:live` does this for you via `pretest:live`).
2. `node-pty` built for the host (it is in the `onlyBuiltDependencies` allowlist; a clean install
   builds the native addon). If it is missing, the live cases skip with that reason.
3. The target provider installed and authenticated:
   - Claude: `claude auth status --json` shows `loggedIn: true`.
   - Codex: `codex doctor --json` shows auth `ok`.
   Each provider's case skips independently when its binary is missing/unauthenticated.

A live run spends **real Anthropic + OpenAI tokens** (it drives real model turns). It is gated OFF by
default and never runs in CI.

---

## Running it

```sh
pnpm test:live
```

That is `CO_LIVE_E2E=1 vitest run … worker-benchmark.live.test.ts` (with a `pretest:live` build). It
runs the benchmark against **both** `claude` and `codex` (Codex parity is the load-bearing unknown —
a claude-only pass does not discharge it). Each provider that is not ready skips loudly.

Each case prints a scorecard line to stderr, e.g.:

```
[worker-benchmark] claude: fidelity=host-live completed=true artifact=true (add() correct over 4 cases) turns=1 stop=done-mail wall=24213ms correctness=1.00 token-economy=N/A context-efficiency=N/A
```

### What the case asserts (hard) vs reports (metric)

Hard-asserted (a failure fails the test):

- `fidelity === 'host-live'` and `assertHostLiveProof` accepts it — a real node-pty (Principle 2);
- `completed` — the agent routed its nonce `clarify_request` to its parent through the live MCP
  surface (proves bind + `LiveDelivery` + mail store end to end);
- `artifact.correct` — the produced `solution.mjs`, **executed**, computes `add()` correctly;
- `scores.correctness === 1` — a completed + correct single-agent run scores a full CORRECTNESS;
- the CO repo tree is unchanged before/after the run (Principle 12 — the agent's cwd is a throwaway
  tmp git repo and all program-data is under a throwaway `CO_DATA_DIR`).

Reported as metrics (logged, not gated): `turnsUsed`, `wallClockMs`, `stopReason`, `artifact.detail`,
and the three scores (below).

### The three scores (`result.scores` — the single-agent twin of the orchestration scorecard)

Each score is `∈ [0,1]` **or `null` = N/A** (never a silent zero). They mirror the orchestration
scorecard so the per-provider corpus is uniform:

| Score | Arms | Definition | Notes |
| --- | --- | --- | --- |
| **CORRECTNESS** | both | `(casesPassed/casesTotal) × (completed ? 1 : 0)` | objective; no implementer merges in the single-agent case, so the orchestration merge-up / review factors are vacuously 1 |
| **TOKEN-ECONOMY** | **live only** | `clamp01(budgetTokens / max(actualTokens, 1))` | **`null` in the sandbox arm** (no real tokens). Sub-signal `cacheEfficiency`. Read via optional chaining against the conductor's per-agent cost rollup — `null` until that surface lands |
| **CONTEXT/TOOL-EFFICIENCY** | both | `0.4·(1−toolFailRate) + 0.4·(1−redundantReadRate) + 0.2·(1−permissionAskRate)` | tunable weights; `null` until the per-agent tool-usage rollup lands |

Raw backing fields ride on `result.scores.tokenEconomy.{inputTokens, outputTokens, cacheReadTokens,
cacheCreationTokens, totalTokens, costUsd, tokenEconomy, cacheEfficiency}` (live-only; `null` in the
sandbox arm) and `result.scores.toolEfficiency.{toolCalls, toolErrors, redundantReads, permissionAsks,
contextEfficiency, turnsToFirstProductiveCoCall, toolCallsPerCompletedTask}` (the last two are un-scored
diagnostics).

> **N/A-in-sandbox rule (no silent zero):** the sandbox arm spends no real tokens, so TOKEN-ECONOMY (and
> every raw token field) is `null`, NOT `0` — a `0` would falsely read as "infinitely wasteful".
> CONTEXT/TOOL-EFFICIENCY is available in both arms (tool calls are observable in the sandbox too).

> **Uncalibrated (honest):** the per-scenario token budget (`add-module = 200,000`) and the
> context-efficiency weights were not measured against a real binary — treat TOKEN-ECONOMY as a relative
> yardstick and tune as the corpus grows.

---

## The scenario

The flagship scenario (`add-module`, in `packages/core/src/bench/worker-scenarios.ts`) asks the agent
to create `solution.mjs` exporting `add(a, b)` using its **own** native file tools, then signal done by
calling `co_mail_send` with a nonce-bearing `clarify_request` to its parent (NOT `worker_done`, which
the `co_mail_send` schema rejects). The done-signal is detected exactly like the host-proof route
proof: a **new** `clarify_request` **from** the hosted agent carrying the run nonce.

Add scenarios by extending `WORKER_BENCH_SCENARIOS`: a `BenchmarkScenario` is `{ id, artifactPath,
subject, body, evaluate }`, where `evaluate(worktreeDir)` executes the artifact and returns
`{ correct, detail, casesPassed, casesTotal }` — the oracle case tally that backs the CORRECTNESS score
(`correct` is exactly `casesPassed === casesTotal`).

---

## Tuning (env overrides)

The host-live timing knobs were never calibrated against a real binary; the first runs are the
calibration. All have safe defaults and are overridable without a code change:

| Env var | Default | Meaning |
| --- | --- | --- |
| `CO_BENCH_MAX_TURNS` | `8` | Max turns before giving up. |
| `CO_BENCH_WALLCLOCK_MS` | `300000` | Overall wall-clock budget per provider. |
| `CO_BENCH_PER_TURN_MS` | `180000` | Per-turn timeout (a wedged turn can't hang the suite). |
| `CO_HOST_LIVE_INJECT_RETRY_MS` | `2000` | Post-inject retry delay (shared with host-proof). |
| `CO_HOST_LIVE_READY_SETTLE_MS` | `4000` | Settle after the pane reaches ready (shared with host-proof). |
| `CO_HOST_PROOF_TRACE` | _unset_ | Set `1` to stream raw pane bytes to stderr for debugging. |

---

## Relationship to v1 acceptance criteria

A passing run is **evidence** an operator reviews, not an automatic checkbox flip. It exercises the
same host-live surface the [`SF-1` / `PV-2`](v1-acceptance-criteria.md) proofs need (a real binary
reaching ready and routing real mail through a real pty), and unlike a scripted host-proof it also
confirms the provider can do real coding work. It does not flip any `☑` — see
[`v1-handoff.md`](v1-handoff.md) for the deferral catalogue and [`sh1-runbook.md`](sh1-runbook.md) for
the full self-host evidence bundle.

# @archmind/retrieval

**Retrieves the smallest subgraph that answers a question — instead of sending the whole codebase to an LLM.**

---

## The problem it solves

After parsing a Laravel project into an execution graph, you still face a choice: send everything to the LLM, or send only what's relevant. Sending everything is wasteful and noisy. Sending only what's relevant requires knowing what *is* relevant.

`@archmind/retrieval` solves this with a focus-aware pruning engine. It classifies every node in the graph by semantic relevance, then returns only nodes that meet the relevance threshold for your query's focus area. The result: 75–95% fewer tokens than naive file-dump RAG, with near-identical recall on what actually matters.

---

## How it works

Each node type is pre-classified by semantic importance:

- **HIGH** — policy checks, permission nodes, auth gates, service calls, transaction boundaries, unscoped queries — the things that cause real bugs
- **MEDIUM** — controller actions, middleware, form requests — structural context
- **LOW** — everything else

When you request a focused retrieval, nodes below the threshold are pruned. Edges between removed nodes are pruned automatically. The remaining graph is self-consistent and ready to pass to the LLM.

---

## Key benefits

**Dramatically fewer tokens**
The retrieval engine consistently achieves 75–95% token savings vs naive file-dump RAG across all benchmark traces, while maintaining 0.97 average recall on HIGH and MEDIUM relevance nodes.

**Semantic focus, not keyword search**
Focus areas (`auth`, `transaction`, `isolation`, etc.) are defined by node type semantics — not by matching strings in code. An `authorization_check` node is always relevant to an auth query, regardless of what it's named.

**Static + runtime in one result**
`fuseWithRuntime()` merges the static retrieval result with runtime span correlations and findings, producing a single unified view of what the code does *and* what it did.

**Benchmark-driven quality gates**
The built-in `runBenchmark()` runner scores retrieval quality against ground-truth golden traces and guards against regressions. Every change can be measured.

---

## Usage

### Static retrieval

```typescript
import { retrieve } from "@archmind/retrieval"

const result = retrieve(
  { entrypoint: "PUT /tasks/{task}", focus: "auth" },
  graphs
)
```

**Focus options:**

| Focus | Returns |
|---|---|
| `all` | Full graph — no pruning |
| `auth` | Auth-critical nodes only (HIGH) |
| `validation` | Validation + auth context (MEDIUM+) |
| `transaction` | Transaction boundaries + escaping side effects (HIGH) |
| `isolation` | Tenant scope violations (HIGH) |
| `runtime` | Runtime injections + middleware (MEDIUM+) |

### Fused retrieval (static + runtime)

```typescript
import { fuseWithRuntime } from "@archmind/retrieval"

const fused = fuseWithRuntime(staticResult, correlatedSession, runtimeFindings)
// fused.runtimeFindings   — N+1, slow query findings from the trace
// fused.correlatedSpans   — which spans map to which graph nodes
// fused.token_estimate    — total tokens including runtime overhead
```

### Benchmarking

```typescript
import { runBenchmark } from "@archmind/retrieval"

const snapshot = runBenchmark({
  goldenDir:        "research/golden-traces/laravel",
  fixtureDir:       "/path/to/laravel-project",
  graphs:           { "LARAVEL-AUTH-001": graphs },
  runtimeGoldenDir: "research/golden-runtime-sessions/laravel",
  workspaceRoot:    ".",
})

console.log(snapshot.summary.avg_r0_recall)       // e.g. 0.97
console.log(snapshot.summary.avg_runtime_recall)  // e.g. 1.00
```

---

## Running tests

```bash
cd packages/retrieval
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js
```

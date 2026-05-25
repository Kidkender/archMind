# @archmind/runtime-correlator

**Connects what happened at runtime back to what the code says should happen — and finds the problems that only show up with real data.**

---

## The problem it solves

Static analysis can tell you that `TaskService::getAll()` is called during a `GET /tasks` request. It cannot tell you that this method triggers 12 separate `SELECT` queries instead of one. That pattern only exists at runtime, with real data.

`@archmind/runtime-correlator` bridges this gap. It takes a normalized `TraceSession` (from `@archmind/runtime-ingest`) and an `IntermediateExecutionGraph` (from `@archmind/laravel-parser`), maps each span to its corresponding graph node, and then runs detectors that can reason about both the code structure *and* the actual runtime behavior together.

---

## What it does

### Span-to-node correlation

Each application span in the trace is matched to a graph node using a cascade of strategies, from most to least precise:

| Strategy | How | When it applies |
|---|---|---|
| Exact symbol match | `span.name === node.symbol` | When OTel is instrumented with ArchMind-compatible naming |
| Namespace + function | `code.namespace` + `code.function` attrs → `ClassName::method` | Standard PHP OTel SDK instrumentation |
| Middleware name | `middleware.name` / `laravel.middleware` attribute | Laravel middleware spans |
| Partial symbol | Substring matching as a last resort | Low-confidence fallback |

The result is a `CorrelatedSession` — every span annotated with the graph node it maps to, its matching strategy, and a confidence level.

### Runtime detectors

Once spans are correlated to nodes, detectors can reason about both dimensions simultaneously.

---

## Detectors

### N+1 query detection

Finds cases where N database queries with the same table execute under a single parent span — the classic sign that a loop is running individual queries instead of a batch.

```
TaskService::getAll (span)
  → SELECT * FROM users WHERE id = 1   (infra span #1)
  → SELECT * FROM users WHERE id = 2   (infra span #2)
  → SELECT * FROM users WHERE id = 3   (infra span #3)
  …12 times
```

The finding tells you: which table, how many queries, which graph node is responsible, and a sample of the SQL statement.

### Slow query detection

Finds individual database queries that exceeded a duration threshold (default: 500ms). Severity scales with duration: medium (500ms+), high (1000ms+), critical (2000ms+).

The finding tells you: the exact query, how long it took, and which graph node triggered it.

---

## Why this matters

These two detectors catch a category of problem that is invisible to static analysis — not because the code is wrong, but because the problem only manifests with real data at scale. A single-item test case won't trigger an N+1. A fast development database won't expose a missing index. Only a real request trace under realistic conditions reveals these.

`@archmind/runtime-correlator` makes this class of problem discoverable through the same ArchMind pipeline as static findings — with evidence, node attribution, and actionable output.

---

## Usage

```typescript
import { correlateSession, detectNPlusOne, detectSlowQuery } from "@archmind/runtime-correlator"
import { ingestOtlpFile } from "@archmind/runtime-ingest"

const session    = ingestOtlpFile("path/to/trace.json")
const correlated = correlateSession(session, graph)

console.log(correlated.correlationRate)  // e.g. 0.87 — 87% of spans matched to nodes

const n1Findings   = detectNPlusOne(correlated)
const slowFindings = detectSlowQuery(correlated, 500)

n1Findings[0].evidence  // "12× SELECT from `users` under a single parent span"
n1Findings[0].nodeIds   // ["svc_TaskService_getAll_ctrl_TaskController_index"]
n1Findings[0].count     // 12
```

---

## Quality gate

A `correlationRate < 0.7` means the trace and graph are not reliably connected — detector results in this case should be treated as low-confidence. The benchmark runner surfaces this metric for every golden runtime session.

---

## Running tests

```bash
cd packages/runtime-correlator
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js
```

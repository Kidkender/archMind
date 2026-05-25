# @archmind/protocol

**The shared type vocabulary for the entire ArchMind system.**

---

## Why this package exists

In a monorepo with 11 packages passing graphs, spans, findings, and conversations between each other, there is only one question that matters: *what does this data actually look like?*

`@archmind/protocol` answers that question once, in one place. Every other package imports from here and nowhere else for shared types. No duplication, no drift, no "which version of ExecutionNode does the retrieval engine expect?"

This is a types-only package — zero runtime code, zero dependencies.

---

## What it contains

### Graph types
The core data structures for execution graphs parsed from PHP source.

- **`ExecutionNode`** — a single node: a controller action, policy check, service call, middleware, transaction boundary, or any other semantic unit in the execution path.
- **`ExecutionEdge`** — a directed relationship between two nodes (e.g. `authorizes_via`, `calls`, `wraps_in_transaction`).
- **`IntermediateExecutionGraph`** — the full graph for one HTTP entrypoint. Everything the parser extracted about how a request flows through the system.
- **`RetrievalResult`** — the pruned subgraph returned by the retrieval engine, with a token estimate.

### Conversation types
Types for multi-turn LLM reasoning sessions.

- **`ConversationTurn`** — one query + response pair.
- **`ConversationContext`** — the full conversation history for a session.
- **`QueryMode`** — `"review" | "teach" | "debug"` — controls how the LLM reasons about the same graph.

### Runtime types
Types for OpenTelemetry-based runtime intelligence.

- **`OtelSpan`** — a single OTel span from a recorded request trace.
- **`TraceSession`** — a complete request trace (root span + all children), normalized and ready for correlation.
- **`CorrelatedSpan`** — a span mapped to a specific graph node, with strategy and confidence metadata.
- **`CorrelatedSession`** — the result of correlating a full trace against an execution graph.
- **`RuntimeFinding`** — a finding produced by a runtime detector (N+1 queries, slow queries, etc.).

---

## Why free-form strings, not enums

Node `type` and edge `relation` are `string`, not union types or enums. This is intentional.

The ArchMind ontology is still being discovered. Locking it into an enum today would mean a breaking change every time a new semantic domain is added. Free-form strings let the ontology evolve in the golden traces and detectors without touching the type definitions.

The current live set of node types is documented in the root [`README.md`](../../README.md) and enforced by the `NODE_TYPE_RELEVANCE` map in `@archmind/retrieval`.

---

## Usage

```typescript
import type {
  ExecutionNode,
  ExecutionEdge,
  IntermediateExecutionGraph,
  OtelSpan,
  TraceSession,
  RuntimeFinding,
  CorrelatedSession,
  QueryMode,
} from "@archmind/protocol"
```

All types are re-exported from the package root — no need to import from sub-paths.

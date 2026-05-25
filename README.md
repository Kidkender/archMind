# ArchMind

**Semantic execution graph engine for Laravel — gives AI assistants a precise map of your code instead of a pile of files.**

---

## The problem with AI code review today

When you ask an LLM to review a Laravel endpoint, the typical approach is to dump relevant files into the prompt and hope the model figures out the relationships. This creates three real problems:

- **Too many tokens** — unrelated code fills the context, diluting signal
- **No structure** — the LLM has to re-derive relationships that already exist in the code
- **Static only** — the LLM can see what *could* happen, but not what *actually* happened at runtime

The result: shallow, generic answers that miss real security issues, race conditions, and performance problems.

---

## What ArchMind does differently

ArchMind compiles your PHP source into a **semantic execution graph** — a structured, queryable representation of how an HTTP request actually flows through your system. When you ask a question, it retrieves only the minimal subgraph relevant to that question, adds runtime trace data if available, and delivers a validated, structured explanation.

```
PHP source + OTel traces
        ↓
  Semantic execution graph
        ↓
  Minimal relevant subgraph (not the whole codebase)
        ↓
  Structured findings (no LLM guessing)
        ↓
  Validated LLM explanation
```

This is a **compiler pipeline**, not a search engine. The difference matters.

---

## Key benefits

**Precision over volume**
Retrieves 6–20 nodes instead of dumping 6 files. 80–95% fewer tokens. Same or better recall on what actually matters.

**Runtime intelligence**
Ingests OpenTelemetry spans and correlates them back to graph nodes. Detects N+1 queries and slow database calls that static analysis cannot see — because they depend on actual data, not code structure.

**Semantic findings, not heuristics**
Seven static detectors (missing authorization, duplicate authorization, event-before-commit, missing tenant scope, etc.) reason about the graph structure, not string patterns. Each finding includes evidence, provenance, and actionable recommendations.

**Mode-aware reasoning**
The same graph can be explained in `review` mode (security-focused), `teach` mode (onboarding), or `debug` mode (incident response). Different cognition surface, same underlying data.

**Claude Code integration**
Ships as an MCP server. Point it at any Laravel project and use `archmind_get_findings`, `archmind_get_execution_graph`, and `archmind_list_entrypoints` directly from Claude Code — no extra tooling.

---

## How it works

### Static pipeline

```
routes/*.php       — extract routes + middleware groups
Kernel.php         — resolve middleware aliases to FQCNs
controllers/       — extract FormRequests, policies, service calls
policies/          — extract authorization logic
services/          — extract transaction boundaries, isolation patterns
        ↓
  IntermediateExecutionGraph
        ↓
  Retrieval engine (focus-aware pruning)
        ↓
  Explainer (7 static detectors)
        ↓
  Prompt builder (mode-aware)
        ↓
  LLM → validated response
```

### Runtime pipeline (Phase 3B)

```
OTLP JSON export
        ↓
  Parse spans (runtime-ingest)
        ↓
  Correlate spans → graph nodes (runtime-correlator)
        ↓
  Run runtime detectors (N+1, slow query)
        ↓
  Fuse with static retrieval result
```

---

## Packages

| Package | What it does |
|---|---|
| [`protocol`](packages/protocol) | Shared TypeScript types — the vocabulary everything else speaks |
| [`laravel-parser`](packages/laravel-parser) | PHP source → execution graph (tree-sitter-php) |
| [`retrieval`](packages/retrieval) | Retrieve the minimal relevant subgraph for a query |
| [`explainer`](packages/explainer) | Detect semantic findings without LLM calls |
| [`prompt-builder`](packages/prompt-builder) | Compile structured prompts with mode support |
| [`llm-client`](packages/llm-client) | LLM abstraction — Claude, OpenAI, and a deterministic Mock |
| [`orchestrator`](packages/orchestrator) | End-to-end reasoning loop + conversation + benchmarks |
| [`scorer`](packages/scorer) | Ground-truth scoring against golden traces |
| [`runtime-ingest`](packages/runtime-ingest) | Parse OTLP JSON exports into normalized span sessions |
| [`runtime-correlator`](packages/runtime-correlator) | Map spans to graph nodes, detect runtime findings |
| [`mcp-server`](packages/mcp-server) | Expose everything as MCP tools for Claude Code |

---

## Quick start

```bash
npm install
npm run build --workspaces --if-present
```

Register the MCP server in Claude Code:

```json
{
  "mcpServers": {
    "archmind": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Then ask Claude Code about any Laravel endpoint. ArchMind will parse the project on first call, cache the result, and return precise findings with full evidence chains.

---

## Benchmark results

Measured against 6 ground-truth golden traces on a real Laravel multi-tenant task management API:

| Trace | R0 Recall | Token savings vs naive RAG |
|---|---|---|
| AUTH-001 (authorization flow) | 1.00 | ~80% |
| AUTH-002 (permission constants) | 1.00 | ~83% |
| VALIDATION-001 | 1.00 | ~78% |
| TXN-001 (transaction boundary) | 0.83 | ~75% |
| ISO-001 (tenant isolation) | 1.00 | ~74% |
| **Average** | **0.97** | **~78%** |

---

## Where this is going

ArchMind is being built in phases:

- **Phase 1–2** — Parser + retrieval engine ✅
- **Phase 3A** — LLM reasoning delivery layer ✅
- **Phase 3B** — Runtime intelligence (OTel spans) ✅
- **Phase 4** — Agentic workflows (repo-wide analysis, automated PR review)
- **Phase 5** — Cross-framework support (beyond Laravel)
- **Phase 6** — Distributed tracing, event → listener reconstruction

The goal: an execution-aware AI intelligence layer that understands not just what your code *can* do, but what it *actually did*.

---

## Running tests

```bash
# Per-package only — do NOT run npm test from the workspace root
cd packages/retrieval
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js
```

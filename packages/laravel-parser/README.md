# @archmind/laravel-parser

**Turns Laravel PHP source code into a structured execution graph — without running the application.**

---

## The problem it solves

Understanding what an HTTP request actually does in a Laravel application requires tracing through routes, middleware stacks, controllers, FormRequests, policies, services, and database calls. Doing this manually is slow. Letting an LLM guess from raw source files is imprecise.

`@archmind/laravel-parser` does this statically and precisely. It uses tree-sitter to parse PHP ASTs and assembles them into an `IntermediateExecutionGraph` that captures the full semantic execution path — including authorization gates, validation, service dependencies, transaction boundaries, and multi-tenant isolation patterns.

---

## What it extracts

Given a Laravel project root, the parser builds a complete graph covering:

| What | How |
|---|---|
| HTTP routes with method + path | Parses `routes/*.php`, inherits middleware groups recursively |
| Middleware chains | Resolves aliases from `Kernel.php` (e.g. `auth` → `Authenticate::class`) |
| Controller actions | Extracts constructor-injected services, `$this->authorize()` calls |
| FormRequest validation | Detects `authorize()` delegation to policies |
| Policy checks | Follows policy method calls into authorization logic |
| Permission constants | Resolves `Permission::TASK_UPDATE` to the string value |
| Transaction boundaries | Detects `DB::transaction()` blocks and side effects that escape |
| Tenant isolation | Detects model queries with and without tenant scope constraints |

---

## How it works

The parser runs as a multi-pass pipeline:

```
1. route-parser       → extract routes with full middleware inheritance
2. kernel-parser      → resolve $middlewareAliases from Kernel.php
3. middleware-mapper  → classify each middleware by FQCN
4. controller-parser  → extract service calls, FormRequests, authorize() calls
5. graph-augmenter    → 5-pass enrichment:
     pass 1: add form_request + policy nodes from controller analysis
     pass 2: service_call nodes from policies and middleware bodies
     pass 3: resolve permission constants (Permission::TASK_UPDATE → "task.update")
     pass 4: detect DB::transaction blocks and escaping side effects
     pass 5: detect unscoped model queries vs tenant-constrained queries
```

The result is an `IntermediateExecutionGraph[]` — one graph per HTTP entrypoint.

---

## Key design decisions

**Scoped service call IDs**
Service call node IDs include their caller: `svc_TaskService_update_ctrl_TaskController_update`. The same service called from a middleware and from a policy creates two distinct nodes. This preserves the execution context in the graph.

**No runtime required**
Everything is derived from static analysis. The parser never executes PHP or spins up a Laravel application.

**Explicit over inferred**
The parser only adds what it can prove from the source. Uncertain relationships (e.g. dynamic middleware) are not guessed — they surface as gaps in adversarial test cases in `research/adversarial-cases/`.

---

## Usage

```typescript
import { augmentGraph } from "@archmind/laravel-parser"

const graphs = await augmentGraph(skeletonGraphs, {
  projectRoot: "/path/to/laravel-project",
  aliasMap:    kernelAliases,   // from parseKernel()
})

// graphs[0].entrypoint   — "PUT /tasks/{task}"
// graphs[0].nodes        — ExecutionNode[]
// graphs[0].edges        — ExecutionEdge[]
```

For lower-level access, individual parsers (`parseRouteFile`, `parseKernel`, `parseControllerMethod`, `parseConstantClass`) can be used independently.

---

## Running tests

```bash
cd packages/laravel-parser
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js
```

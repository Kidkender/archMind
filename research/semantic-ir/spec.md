# ArchMind Semantic IR — Specification v1.0

## Motivation

ArchMind's goal is to be an *execution-aware intelligence layer*, not a parser factory.

The wrong architecture:

```
Laravel Analyzer  →  Laravel Graph
NestJS Analyzer   →  NestJS Graph
Django Analyzer   →  Django Graph
```

The right architecture (this document):

```
Laravel Adapter  ─┐
NestJS Adapter   ─┼──▶  Semantic IR  ──▶  Graph Engine  ──▶  Retrieval  ──▶  LLM
Django Adapter   ─┘
```

Framework adapters are thin compilers. The Semantic IR is the asset.
Detection logic, retrieval, and reasoning operate on IR — once, for all frameworks.

This is the same model as LLVM: each language frontend emits to a common IR;
optimization passes run on the IR, not on each language separately.

---

## Design Principles

1. **Framework concepts map TO IR — never the reverse.** IR nodes are abstract. Adapters are concrete.
2. **IR is structurally stable.** Adding a new framework never changes the IR schema.
3. **Semantic equivalence is explicit.** Laravel `middleware('auth')` and NestJS `@UseGuards(AuthGuard)` both emit `AUTH_GATE` — the IR makes this equivalence formal.
4. **Traceability is first-class.** Every IR edge carries how it was derived: `static`, `semantic`, `runtime`, or `probabilistic`.
5. **Confidence is explicit.** Detections that cannot be proven statically carry `LOW` confidence rather than false precision.

---

## IR Node Types

Node types are the vocabulary of the IR. They are framework-agnostic.
Each adapter maps framework constructs to these types.

### HTTP Request Domain

| IR Type | Meaning | Laravel example | NestJS example | Django example |
|---|---|---|---|---|
| `ENTRYPOINT` | An HTTP route that can receive a request | `Route::put('/tasks/{id}', ...)` | `@Put(':id')` in a controller | `path('tasks/<id>/', view)` |
| `AUTH_GATE` | Enforces that the caller is authenticated | `middleware('auth:sanctum')` | `@UseGuards(JwtAuthGuard)` | `@login_required` |
| `AUTHZ_CHECK` | Evaluates caller's permission on a resource | `$this->authorize('update', $task)` | `@UseGuards(RolesGuard)` | `@permission_required('tasks.change')` |
| `BUSINESS_HANDLER` | The function that executes business logic | Controller method body | Controller method body | View function body |
| `VALIDATION_GATE` | Enforces shape/type constraints on input | `FormRequest` class | `@UsePipes(ValidationPipe)` + DTO | `serializer.is_valid()` |
| `SERVICE_CALL` | A call to a domain service (injected dependency) | `$this->taskService->update()` | `this.taskService.update()` | `self.task_service.update()` |
| `PERMISSION_CONSTANT` | A specific permission value being evaluated | `Permission::TASK_UPDATE` | `'tasks:update'` string | `'tasks.change'` |

### Runtime Context Domain

| IR Type | Meaning |
|---|---|
| `RUNTIME_INJECT` | A value written to the request-scoped container |
| `RUNTIME_CONSUME` | A value read from the request-scoped container |
| `TENANT_CONTEXT` | The tenant identity for the current request |

### Data Access Domain

| IR Type | Meaning |
|---|---|
| `SCOPED_QUERY` | A DB query with tenant/owner constraint applied |
| `UNSCOPED_QUERY` | A DB query on a tenant-owned model without constraint |

### Transaction Domain

| IR Type | Meaning |
|---|---|
| `TXN_BOUNDARY` | Marks the open/commit/rollback of a DB transaction |
| `TXN_WRITE` | A DB write inside a transaction scope |
| `TXN_ESCAPE` | A side effect inside a transaction that is NOT rolled back on failure |

---

## IR Edge Relations

Edges express how nodes relate within the execution graph.

| Relation | From | To | Meaning |
|---|---|---|---|
| `precedes` | any | any | Node A must execute before node B in the request lifecycle |
| `calls` | `BUSINESS_HANDLER` / `SERVICE_CALL` | `SERVICE_CALL` | Direct method call |
| `guards` | `AUTH_GATE` / `AUTHZ_CHECK` | `BUSINESS_HANDLER` | Gate protects handler execution |
| `validates` | `VALIDATION_GATE` | `BUSINESS_HANDLER` | Validation gates handler |
| `injects` | `RUNTIME_INJECT` | `RUNTIME_CONSUME` | Value flows from inject to consume |
| `checks_permission` | `AUTHZ_CHECK` | `PERMISSION_CONSTANT` | Which permission is being evaluated |
| `accesses` | `BUSINESS_HANDLER` / `SERVICE_CALL` | `SCOPED_QUERY` / `UNSCOPED_QUERY` | Node performs a DB query |
| `wraps` | `TXN_BOUNDARY` | `TXN_WRITE` / `TXN_ESCAPE` | Node is enclosed by this transaction |
| `escapes` | `TXN_ESCAPE` | (external system) | Side effect fires before commit |

### Traceability levels

Every edge carries `traceability`:

| Level | Meaning |
|---|---|
| `static` | Derivable from AST alone (direct call, explicit route) |
| `semantic` | Requires framework ontology knowledge (DI resolution, policy dispatch) |
| `runtime` | Requires execution traces or OpenTelemetry data |
| `probabilistic` | Heuristic inference — confidence < 1.0 |

---

## IR Graph Structure

One `ExecutionGraph` per route entrypoint.

```
ExecutionGraph {
  entrypoint:  string        // "PUT /tasks/{id}"
  method:      HTTPMethod    // "PUT"
  path:        string        // "/tasks/{id}"
  framework:   string        // "laravel" | "nestjs" | "django" — for diagnostics only
  adapter_ver: string        // adapter version that emitted this graph
  ir_ver:      string        // IR spec version (this document = "1.0")
  nodes:       IRNode[]
  edges:       IREdge[]
  annotations: IRAnnotation[]
}

IRNode {
  id:         string         // stable, scoped: "auth_gate::sanctum::route_put_tasks"
  type:       IRNodeType     // one of the types above
  symbol:     string         // human-readable source reference
  file?:      string         // relative path from project root
  args?:      string[]       // e.g. ["tasks:update"] for PERMISSION_CONSTANT
  role?:      string         // additional semantic hint
  confidence: Confidence     // HIGH | MEDIUM | LOW | UNKNOWN
  source:     SourceRef      // where in adapter code this was emitted
}

IREdge {
  from:         string
  to:           string
  relation:     IREdgeRelation
  traceability: Traceability
  mechanism?:   string       // e.g. "$this->authorize('update', $task)"
}

IRAnnotation {
  type:       AnnotationType
  nodes:      string[]
  description: string
  severity:   "critical" | "high" | "medium" | "low"
  confidence: Confidence
  fix?:       string
}
```

---

## Annotation Types (Detections)

Detections run on IR — they do not depend on framework.
A detection that works on Laravel IR works on NestJS IR automatically.

| Annotation | Trigger condition | Severity |
|---|---|---|
| `AUTH_GAP` | `ENTRYPOINT` reachable without any `AUTH_GATE` on path | critical |
| `AUTHZ_GAP` | `AUTH_GATE` present but no `AUTHZ_CHECK` on path | high |
| `MISSING_POLICY` | `BUSINESS_HANDLER` accesses resource, no `AUTHZ_CHECK` guards it | high |
| `DOUBLE_CHECK` | Two `AUTHZ_CHECK` nodes check same permission on same path | medium |
| `TXN_ESCAPE` | `TXN_ESCAPE` node inside `TXN_BOUNDARY` without after-commit guarantee | high |
| `MISSING_TXN` | 2+ `TXN_WRITE` nodes on path with no enclosing `TXN_BOUNDARY` | medium |
| `ISOLATION_RISK` | `UNSCOPED_QUERY` on tenant model when `TENANT_CONTEXT` is present | high |

---

## Adapter Contract

Each framework adapter MUST:

1. **Accept** a project root path and return `ExecutionGraph[]`
2. **Emit only IR node types** defined in this spec — no framework-specific strings in the IR
3. **Set `confidence`** on every node: `HIGH` for AST-proven, `LOW` for heuristic
4. **Set `traceability`** on every edge
5. **Set `framework` and `adapter_ver`** on every graph (for debugging — not used by engine)
6. **Pass the IR Conformance Test Suite** before being merged

What adapters are allowed to do privately (not visible in IR):
- Use any parser (tree-sitter, LSP, regex) internally
- Maintain internal resolution maps (DI tokens, alias maps, etc.)
- Emit intermediate structures before collapsing to IR

What adapters must NOT do:
- Emit node types not in this spec without first updating the spec
- Use framework-specific strings as node `type` values
- Emit edges with relation `"calls"` between nodes of type `AUTH_GATE` → `BUSINESS_HANDLER` (use `"guards"` instead)

---

## Framework Mapping Reference

### Auth patterns across frameworks

| Framework | Authentication | IR type |
|---|---|---|
| Laravel | `Route::middleware('auth:sanctum')` | `AUTH_GATE` |
| Laravel | `Authenticate` middleware class | `AUTH_GATE` |
| NestJS | `@UseGuards(JwtAuthGuard)` | `AUTH_GATE` |
| NestJS | `@UseGuards(AuthGuard('jwt'))` | `AUTH_GATE` |
| Django | `@login_required` decorator | `AUTH_GATE` |
| Django | `IsAuthenticated` in `permission_classes` | `AUTH_GATE` |
| Spring | `@PreAuthorize("isAuthenticated()")` | `AUTH_GATE` |

### Authorization patterns across frameworks

| Framework | Authorization | IR type |
|---|---|---|
| Laravel | `$this->authorize('update', $task)` | `AUTHZ_CHECK` |
| Laravel | `CheckPermission` middleware with permission arg | `AUTHZ_CHECK` |
| NestJS | `@UseGuards(RolesGuard)` + `@Roles(...)` | `AUTHZ_CHECK` |
| NestJS | `@CheckPolicies(...)` with `PoliciesGuard` | `AUTHZ_CHECK` |
| Django | `@permission_required('app.change_task')` | `AUTHZ_CHECK` |
| Django | `IsAdminUser` in `permission_classes` | `AUTHZ_CHECK` |
| Spring | `@PreAuthorize("hasRole('ADMIN')")` | `AUTHZ_CHECK` |

### Runtime injection patterns

| Framework | Pattern | IR type |
|---|---|---|
| Laravel | `app()->instance('tenant', $tenant)` | `RUNTIME_INJECT` |
| Laravel | `app('tenant')` read | `RUNTIME_CONSUME` |
| NestJS | `REQUEST`-scoped provider | `RUNTIME_INJECT` |
| NestJS | Constructor injection of REQUEST-scoped service | `RUNTIME_CONSUME` |
| Django | `request.tenant = tenant` in middleware | `RUNTIME_INJECT` |
| Django | `request.tenant` read in view | `RUNTIME_CONSUME` |

---

## Versioning

This spec is versioned. Breaking changes require a major version bump.

**Breaking changes** (require new major version):
- Removing or renaming an IR node type
- Changing the meaning of a node type
- Removing an edge relation

**Non-breaking changes** (minor version bump):
- Adding a new IR node type
- Adding a new edge relation
- Adding a new annotation type
- Adding rows to the framework mapping reference

All `ExecutionGraph` objects carry `ir_ver` so the engine can handle
graphs emitted by different adapter versions.

---

## What is NOT in scope for the IR

The IR is static by design. These require a future `Runtime IR` extension:

- Actual execution traces (which code paths were taken at runtime)
- Performance data (latency, query count per request)
- Real tenant IDs or user IDs (these are runtime values)

The static IR describes **what could happen**. Runtime IR will describe **what did happen**.
That gap is where ArchMind's long-term moat lives.

---

## Relationship to existing `@archmind/protocol`

The existing `graph.ts` in `packages/protocol/` predates this spec and uses
Laravel-specific strings (`"middleware"`, `"form_request"`, `"policy"`) as node types.

Migration path:
1. This spec defines the canonical IR vocabulary going forward.
2. The Laravel adapter will be updated to emit IR types (`AUTH_GATE`, `AUTHZ_CHECK`, etc.)
   with a compatibility shim for existing golden traces during transition.
3. `packages/protocol/src/graph.ts` will be updated to use IR type constants.
4. Golden traces will be migrated in a single pass after the Laravel adapter is updated.

Until migration is complete, `graph.ts` NODE_TYPES are the source of truth for
production code. This spec is the target.

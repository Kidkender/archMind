# ArchMind Semantic IR — Specification v1.0

> **FROZEN — 2026-06-04 | Validated — 2026-06-04 (sprint P0-P2)**
> IR vocabulary is stable. Validated against 10 NestJS projects (140 routes) and 12 Laravel
> projects (154 routes) in sprint P0-P2. All auth/authz/validation patterns discovered map
> cleanly to existing node types — no new types were needed.
>
> Evidence: NestJS auth 41%→72%, authz 4%→23%. Laravel auth 59%→77%, authz 5%→13%.
> Improvements came entirely from parser/classifier fixes, NOT from IR changes.
> This confirms IR v1 node taxonomy is expressive enough for both frameworks.
>
> New node types, edge relations, or annotation types require a spec update + version bump
> before being used in any adapter. Framework #3 may only begin after IR Migration completes.

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

## Resource Semantics (IR v1.1)

> **Status**: Implemented — 2026-06-10.
> Laravel adapter emits ir:resource nodes for route-model-binding params.
> ir:resource_mismatch and resource_unprotected detectors run on IR (framework-agnostic).
> ir_version bumped 1.0 → 1.1 (non-breaking, additive).

### Problem

The current IR can detect that an `AUTHZ_CHECK` is *present or absent*, but cannot detect that
the authorization targets a *different resource* than the one being accessed. Example:

```php
// Controller method
public function update(Request $request, int $orderId)
{
    Gate::authorize('update', $this->user);   // authorizes: User
    $order = Order::find($orderId);           // accesses: Order
    $order->update($request->validated());
}
```

The graph today emits one `AUTHZ_CHECK` node → detector sees authorization present → no finding.
The actual security issue — authorizing on `User` while accessing `Order` — is invisible to the engine.

This is an **IR design gap**, not a context ceiling. The information (which resource is being
authorized, which resource is being accessed) is statically recoverable but not being encoded.

### RESOURCE Node Type

```
RESOURCE
  id:     string   // scoped: "resource::{ClassName}::{route_id}"
  type:   "ir:resource"
  symbol: string   // class name: "User", "Order", "Task"
  file?:  string   // model file if resolvable
  role:   "authorized_resource" | "accessed_resource"
```

### New Edges

| Relation | From | To | Meaning |
|---|---|---|---|
| `authorizes` | `AUTHZ_CHECK` | `RESOURCE` | Which resource this check protects |
| `accesses` | `BUSINESS_HANDLER` / `SERVICE_CALL` | `RESOURCE` | Which resource this node reads/writes |

### Resource Recovery Strategy

**Statically recoverable (HIGH confidence):**

| Pattern | Resource | Recovery method |
|---|---|---|
| Method signature: `update(User $user)` | `User` | Route model binding — first typed param |
| `Gate::authorize('update', $user)` | type of `$user` | Var type from signature |
| `$this->authorize('update', $task)` | type of `$task` | Var type from signature |
| `Order::find(...)` | `Order` | Static model class name |
| `Order::where(...)->get()` | `Order` | Static model class name |
| NestJS: `@Param() userId`, then `UserService.findOne(userId)` | `User` | Service call name heuristic |

**Not statically recoverable (mark as UNKNOWN):**

| Pattern | Reason |
|---|---|
| `$model = $this->repository->find($id)` | Dynamic dispatch, return type unknown without type inference |
| `$class::find($id)` where `$class` is a variable | Variable class name |
| `app()->make($type)::find(...)` | Runtime container resolution |

### New Annotation: `RESOURCE_MISMATCH`

| Annotation | Trigger | Severity |
|---|---|---|
| `RESOURCE_MISMATCH` | `AUTHZ_CHECK` has `authorizes → Resource(A)` but the handler has `accesses → Resource(B)` where A ≠ B | critical |

This replaces what is currently mislabeled as "context ceiling" in DELEGATED-AUTH-001 and similar traces.

### Impact on Existing Known Limitations

The following traces in CLAUDE.md are labeled "context ceiling" but should be re-labeled
"Missing resource semantics" once this section is implemented:

- `ECOMERCE-DELEGATED-AUTH-001` — authorizes `User`, accesses `Product`
- `EASYGO-ADMIN-AUTH-001` — no `ProductPolicy` in graph because policy class doesn't exist
  (this one remains a true context ceiling — policy class must exist to be detected)

### Implementation Notes for Adapters

When implementing RESOURCE nodes, adapters MUST:
1. Only emit `RESOURCE` nodes when the resource class is statically determinable
2. Set `confidence: HIGH` for route-model-binding params, `confidence: LOW` for heuristic inferences
3. Never guess resource types — emit `UNKNOWN` rather than a wrong type
4. The `RESOURCE_MISMATCH` detector runs on IR; adapters only emit nodes and edges

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

| Framework | Authentication | IR type | Discovery method |
|---|---|---|---|
| Laravel | `Route::middleware('auth:sanctum')` | `AUTH_GATE` | route-parser |
| Laravel | `Authenticate` middleware class | `AUTH_GATE` | kernel-parser + middleware-mapper |
| NestJS | `@UseGuards(JwtAuthGuard)` | `AUTH_GATE` | route-extractor decorator scan |
| NestJS | `@UseGuards(AuthGuard('jwt'))` | `AUTH_GATE` | route-extractor, string-arg form |
| NestJS | `@UseGuards(AuthGuard({ public: ... }))` | `AUTH_GATE` | route-extractor, object-arg form |
| NestJS | `APP_GUARD` token in module providers | `AUTH_GATE` | module.resolver |
| NestJS | `NestModule.configure()` → `consumer.apply(AuthMiddleware).forRoutes(...)` | `AUTH_GATE` | middleware.scanner |
| NestJS | Custom decorator wrapping `applyDecorators(UseGuards(...))` | `AUTH_GATE` | decorator.scanner |
| Django | `@login_required` decorator | `AUTH_GATE` | — |
| Django | `IsAuthenticated` in `permission_classes` | `AUTH_GATE` | — |
| Spring | `@PreAuthorize("isAuthenticated()")` | `AUTH_GATE` | — |

### Authorization patterns across frameworks

| Framework | Authorization | IR type | Discovery method |
|---|---|---|---|
| Laravel | `$this->authorize('ability', $model)` | `AUTHZ_CHECK` | controller-parser, instance method |
| Laravel | `Gate::authorize('ability', $model)` | `AUTHZ_CHECK` | controller-parser, static facade (`scoped_call_expression`) |
| Laravel | `Gate::allows('ability', $model)` | `AUTHZ_CHECK` | controller-parser, static facade |
| Laravel | `CheckPermission` middleware with permission arg | `AUTHZ_CHECK` | middleware-mapper |
| Laravel | `can:ability` route middleware | `AUTHZ_CHECK` | route-parser |
| NestJS | `@UseGuards(RolesGuard)` + `@Roles(...)` | `AUTHZ_CHECK` | route-extractor + guard.classifier |
| NestJS | `@UseGuards(ShareOwnerGuard)` / `OwnerGuard` pattern | `AUTHZ_CHECK` | guard.classifier pattern `OwnerGuard$` |
| NestJS | `@UseGuards(AdministratorGuard)` / `AdminGuard` pattern | `AUTHZ_CHECK` | guard.classifier pattern `Admin(istrator)?Guard$` |
| NestJS | `@UseGuards(ShareSecurityGuard)` / `SecurityGuard` pattern | `AUTHZ_CHECK` | guard.classifier pattern `SecurityGuard$` |
| NestJS | `@CheckPolicies(...)` with `PoliciesGuard` | `AUTHZ_CHECK` | guard.classifier |
| NestJS | Custom `@Auth([RoleType.ADMIN])` wrapping `applyDecorators(UseGuards(AuthGuard, RolesGuard))` | `AUTH_GATE` + `AUTHZ_CHECK` | decorator.scanner |
| Django | `@permission_required('app.change_task')` | `AUTHZ_CHECK` | — |
| Django | `IsAdminUser` in `permission_classes` | `AUTHZ_CHECK` | — |
| Spring | `@PreAuthorize("hasRole('ADMIN')")` | `AUTHZ_CHECK` | — |

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

## What is NOT in IR v1

### Explicitly excluded node types

These constructs exist in real frameworks but are **not modeled in IR v1**.
Adding them requires a spec update + version bump.

| Construct | Reason excluded | Future version |
|---|---|---|
| `RESOURCE` | Requires type inference to link authz target to access target. Spec drafted but not implemented. | v1.1 (deferred correctness enhancement) |
| Rate limiter / throttle | Operational concern, not a security semantic | v2.x |
| Cache layer | Runtime optimization, not static semantic | v2.x |
| Exception filter | Response shaping, not execution guard | — |
| Interceptor (NestJS) | Unless it performs auth/authz, it is cross-cutting infrastructure | — |
| `@Public()` / opt-out decorators | Modeled as `isPublic` flag on route, not as a node | — |
| Versioned routes (`/v1/`, `/v2/`) | Version prefix is part of path, not a semantic node | — |

### Explicitly excluded patterns

These patterns are **not statically resolvable** by the current adapters and will
produce no node rather than a wrong node (fail-safe):

| Pattern | Framework | Why not modeled |
|---|---|---|
| Dynamic middleware: `if ($env) Route::middleware(...)` | Laravel | Conditional at runtime |
| Reflection-based DI: `app()->make($className)` | Laravel | Dynamic container resolution |
| Middleware applied via `NestModule.configure()` with controller class ref | NestJS | Requires route→controller resolution not yet implemented |
| Custom decorator factory with complex runtime args | NestJS | Requires type inference |
| `applyDecorators()` nested more than 1 level deep | NestJS | Only 1-level unwrap implemented |

### Runtime constructs (future `Runtime IR`)

| Construct | Reason excluded |
|---|---|
| Actual execution traces (which paths ran) | Runtime, not static |
| Performance data (latency, query count) | Runtime, not static |
| Real tenant IDs or user IDs | Runtime values |

The static IR describes **what could happen**. Runtime IR will describe **what did happen**.
That gap is where ArchMind's long-term moat lives.

---

## Relationship to existing `@archmind/protocol`

### Migration status (as of 2026-06-04)

| Component | Status |
|---|---|
| `packages/protocol/src/ir.ts` | ✅ IR types defined (`IR_NODE_TYPES`, `IR_EDGE_RELATIONS`, `IR_ANNOTATION_TYPES`) |
| NestJS adapter (`nestjs-parser`) | ✅ Emits IR types exclusively (`ir:auth_gate`, `ir:authz_check`, etc.) |
| Laravel adapter (`laravel-parser`) | ⚠️ Partially migrated — middleware-mapper and graph-augmenter emit IR types; backward-compat shims remain for `"controller_action"`, legacy `mwTypes` |
| `packages/protocol/src/graph.ts` | ⚠️ Still defines legacy `NODE_TYPES` for backward compat; `LARAVEL_TO_IR` shim maps them |
| Golden traces (Laravel) | ✅ Already use IR type strings (`ir:auth_gate`, `ir:authz_check`, etc.) |
| Golden traces (NestJS) | ✅ Use IR type strings from day 1 |
| Retrieval engine (`NODE_TYPE_RELEVANCE`) | ✅ Has entries for both IR types and legacy types (migration window) |

### Remaining migration tasks (Phase 10)

1. Remove `|| n.type === "controller_action"` backward-compat guards in `graph-augmenter.ts`
   — blocked until all real-project graphs are confirmed to emit `ir:business_handler`
2. Remove legacy `"middleware"`, `"authorization_check"`, `"authentication_gate"` from `mwTypes`
   in `graph-augmenter.ts`
3. Clean legacy entries from `NODE_TYPE_RELEVANCE` in `retrieval-engine.ts`
4. Remove `NODE_TYPES` (legacy) from `graph.ts` once Laravel adapter is fully migrated
5. Update `DEDUP_TYPES` in `retrieval-engine.ts` to IR-types-only

**Do not attempt Phase 10 items without running the full benchmark suite first** —
the backward-compat shims are load-bearing for real projects that may still emit legacy types.

---
id: LARAVEL-RUNTIME-001
framework: laravel
category: runtime-dependency
difficulty: high
entrypoint: ANY /tasks/* endpoint
expected_nodes:
  - ResolveTenant
  - app()->instance('tenant')
  - TaskController (6 usages)
  - RequireFeature
expected_edges:
  - ResolveTenant -> app()->instance('tenant') (runtime inject)
  - app()->instance('tenant') -> TaskController::* (implicit contract)
  - app()->instance('tenant') -> RequireFeature::handle (implicit contract)
semantic_primitives:
  - RuntimeInjection
  - ImplicitContract
  - TenantContext
  - ContainerResolution
runtime_contract: true
golden_trace: golden-traces/laravel/LARAVEL-RUNTIME-001.yaml
source_project: tenant-workspace-api
---

# LARAVEL-RUNTIME-001 — Hidden Runtime Dependency: app('tenant')

## Symptom

`TaskController` uses `app('tenant')` in every method, but this value is
injected by `ResolveTenant` middleware at runtime. There is no type hint,
no constructor injection, and no visible contract between the controller
and the middleware. The dependency is invisible to static analysis.

## Trigger Query

```
Where does app('tenant') in TaskController come from?
```

or:

```
What happens if ResolveTenant middleware is removed from task routes?
```

or:

```
Explain the tenant resolution flow for task endpoints
```

## Ground Truth Execution Path

```
Any task request

auth:sanctum
  ↓
ResolveTenant::handle()
  → $tenantId = $request->header('X-Tenant-ID')
  → $tenant = Tenant::find($tenantId)
  → app()->instance('tenant', $tenant)   ← RUNTIME INJECT
  ↓
TaskController::*()
  → $tenant = app('tenant')              ← CONSUME (6 methods)
```

## Implicit Contract

```
ResolveTenant                   TaskController
─────────────                   ──────────────
app()->instance('tenant', ...)  app('tenant')
       ↑ inject                        ↑ consume
       same string key — no explicit link in code
```

Pattern repeats across: `RequireFeature` middleware, likely `AnalyticsController`.

## Why Current AI Fails

- `app('tenant')` in `TaskController` has no traceable static origin
- No type hint, no constructor param, no docblock
- Semantic search returns both files separately — cannot infer the
  middleware → container → controller data flow
- AI cannot determine whether `app('tenant')` will be null at runtime
  without tracing the route group middleware chain

## Expected ArchMind Output

```
Tenant resolution flow:

ResolveTenant::handle()
  reads: X-Tenant-ID header
  queries: Tenant::find($tenantId)
  injects: app()->instance('tenant', $tenant)   ← RUNTIME EDGE

Downstream consumers:
  → TaskController (6 methods: index, show, store, update, destroy, assign)
  → RequireFeature middleware

Contract enforced by:
  routes/api.php — Route::middleware(ResolveTenant::class)->group(...)

⚠ RISK: Task route added outside this group → app('tenant') returns null
  → silent failure, no compile-time error.
```

## Token Comparison (estimated)

| Approach | Files injected | Token estimate |
|---|---|---|
| Naive RAG | ResolveTenant, TaskController, all middleware, AppServiceProvider | ~22k |
| ArchMind | Inject node + consumer nodes + contract edge | ~1.5k |

## Files Involved

- `app/Http/Middleware/ResolveTenant.php`
- `app/Http/Middleware/RequireFeature.php`
- `routes/api.php`
- `app/Modules/Task/Http/Controllers/TaskController.php`
- `app/Providers/AppServiceProvider.php`

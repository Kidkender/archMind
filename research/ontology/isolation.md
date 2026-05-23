# Semantic Primitive: Multi-Tenant Isolation

## Overview

Multi-tenant isolation semantics describe how a system ensures that one tenant's data
cannot be accessed or mutated by another tenant's request. In Laravel SaaS applications,
the most common failure mode is a **query that is tenant-aware by intention but missing
the tenant scope constraint** — allowing any authenticated user to resolve another tenant's
records simply by guessing an ID.

This is distinct from authorization (who can do what) — isolation is about
**which data is even visible** at the query layer. Authorization gates run after data
is resolved; isolation prevents wrong data from ever being resolved.

---

## Primitives

### TenantScope

A query constraint that restricts a database query to the current tenant's data.

**Properties:**
- `constraint_type`: `where_clause` | `global_scope` | `scoped_binding` | `policy_check`
- `tenant_field`: database column used (`tenant_id`, `organization_id`, etc.)
- `tenant_source`: where the tenant value comes from (`app('tenant')`, `$request->user()->tenant_id`, etc.)

**Laravel manifestations:**
```php
// Explicit where clause
Task::where('tenant_id', $tenant->id)->find($id);

// Eloquent global scope (transparent — automatic on all queries)
// Defined in: Task::booted() → static::addGlobalScope(new TenantScope)

// Scoped route model binding
// Defined in: AppServiceProvider → Route::bind('task', fn => Task::whereTenant()->find(...))
```

---

### UnscopedQuery

A database query on a tenant-aware model that does NOT apply a tenant constraint,
within an execution context where a tenant is known.

**Properties:**
- `model`: the model being queried (`Task`, `Project`, etc.)
- `operation`: `find` | `where` | `first` | `all` | `paginate`
- `tenant_field_present`: false — no `where tenant_id = ?` in query chain
- `global_scope_assumed`: whether a global scope might compensate (unverifiable statically)

**Detection heuristic:**
- `Model::find($id)` — no chained `where('tenant_id', ...)` before resolution
- `Model::where('id', $id)->first()` — no tenant constraint in where chain
- `$model->tasks()->find($id)` — relation not verified to be tenant-scoped

**Critical distinction:** If the model has a registered global `TenantScope`, the query
IS scoped automatically — but this is only visible in `AppServiceProvider` or model `booted()`,
not at the call site. Static analysis cannot confirm global scope presence without full
service provider parsing. → must emit with `LOW` confidence or `unknown_global_scope` uncertainty.

---

### TenantBoundaryViolation

A detectable structural gap where:
1. The execution path has a resolved `TenantContext` (tenant is known)
2. A model is queried without confirming tenant scope
3. The model is logically tenant-owned (inferred from naming or seeder data)

**Properties:**
- `model`: the tenant-owned model being accessed without scope
- `tenant_context_node`: the RuntimeInjection or middleware that provides tenant
- `unscoped_query_node`: the UnscopedQuery node
- `confidence`: `LOW` (global scope may exist) to `HIGH` (explicit query, no scope evidence)

**Why this matters:**
- An attacker in tenant A can request `GET /tasks/42` where task 42 belongs to tenant B
- If no tenant scope is applied, the query resolves and returns tenant B's data
- Authorization checks (policies) may still pass if the user has the `task.view` permission
- The isolation failure is invisible to the policy layer

---

### GlobalScopeAssumption

An unverifiable assumption that a model's global scope provides tenant isolation.

**Properties:**
- `model`: the model being assumed to have a global scope
- `evidence`: none (no static evidence found) | `naming_convention` (`TenantScope` class exists)
- `confidence`: LOW

**Impact on detection:** When a global scope assumption is present, the finding confidence
drops to `LOW` and an `unknown_global_scope` uncertainty is added.

---

## Detectable Patterns

### MissingTenantScope (LARAVEL-ISO-001)

Controller resolves a model by ID without tenant constraint, in a request context
where the tenant is known.

```php
// Tenant is resolved by middleware upstream
// $tenant = app('tenant') → ResolveTenant injects this

public function show(string $id): JsonResponse
{
    // DANGEROUS: no tenant constraint
    $task = Task::find($id);

    // Authorization passes — user has permission — but task belongs to tenant B
    $this->authorize('view', $task);

    return response()->json($task);
}
```

**vs safe:**
```php
$task = Task::where('tenant_id', $tenant->id)->findOrFail($id);
// OR: Task model has global TenantScope registered in booted()
```

**Detection rule:**
- `runtime_injection` node with key `tenant` in graph
- `unscoped_query` node on a tenant-named model (`Task`, `Project`, `Invoice`, etc.)
- No `tenant_scoped_query` evidence on same model in same controller scope
- Finding: `missing_tenant_scope` with confidence `LOW` (global scope may exist)

---

### CrossTenantWrite (future — LARAVEL-ISO-002)

A write operation on a model without verifying the model belongs to current tenant.

```php
$task->update($data);  // if $task was resolved without tenant scope, this writes cross-tenant
```

---

## Graph Node Types (ontology extension)

| `type` | `role` | Description |
|---|---|---|
| `unscoped_query` | `data_access` | Query on tenant model without tenant constraint |
| `tenant_scoped_query` | `data_access` | Query with confirmed tenant constraint |

## Edge Relations (ontology extension)

| `relation` | Meaning |
|---|---|
| `accesses_model` | Node reads/writes a model (general) |
| `missing_tenant_scope` | UnscopedQuery lacks tenant constraint in tenant context |

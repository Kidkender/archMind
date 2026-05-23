# LARAVEL-ISO-001: Missing Tenant Scope on Model Query

## Pain Summary

A controller resolves a model by raw ID (`Task::find($id)`) without applying a tenant
constraint, inside a route that is tenant-scoped by middleware. Any authenticated user
in any tenant can access another tenant's records by guessing or enumerating IDs.

This bug passes all authorization checks — the user has the right permission, the policy
approves the action — but the **wrong tenant's data** is returned or modified.

---

## Scenario

```
GET /tasks/{id}  →  TaskController::show()
```

Route is inside the tenant middleware group:
```php
Route::middleware(['auth:sanctum', 'resolve.tenant', 'check.permission:task.view'])
    ->group(function () {
        Route::get('/tasks/{id}', [TaskController::class, 'show']);
    });
```

`ResolveTenant` middleware injects tenant into container:
```php
class ResolveTenant
{
    public function handle(Request $request, Closure $next): Response
    {
        $tenant = Tenant::where('id', $request->header('X-Tenant-ID'))->firstOrFail();
        app()->instance('tenant', $tenant);
        return $next($request);
    }
}
```

Controller resolves task without tenant constraint:
```php
class TaskController
{
    public function show(string $id): JsonResponse
    {
        $task = Task::find($id);              // ← no tenant scope

        $this->authorize('view', $task);      // passes — user has task.view

        return response()->json($task);       // returns tenant B's task to tenant A user
    }
}
```

---

## Why This Is a Bug

**Request from Tenant A user:**
1. `ResolveTenant` injects `$tenant = Tenant A`
2. `CheckPermission` checks `task.view` → passes (user has the permission)
3. `Task::find(42)` — queries `SELECT * FROM tasks WHERE id = 42`
4. Task 42 belongs to **Tenant B** — no constraint applied
5. `TaskPolicy::view` called with Tenant A user + Tenant B task
6. Policy checks `hasPermission(TASK_VIEW)` → passes (permission check only, no tenant check)
7. **Tenant B's task is returned to Tenant A user** ← data leak

**Root cause:** Isolation is not enforced at the query layer. Authorization checks permission
but not tenant ownership of the resolved model.

---

## Execution Graph Shape

```
GET /tasks/{id}
  └─ auth:sanctum          (authentication_gate)
  └─ ResolveTenant::handle (middleware → runtime_injection: tenant)
  └─ CheckPermission::handle (authorization_check: task.view)
  └─ TaskController::show  (controller_action)
       └─ Task::find        (unscoped_query ← danger)
       └─ TaskPolicy::view  (policy — checks permission, not ownership)
```

**Critical missing edge:**
- `Task::find` → `missing_tenant_scope` → `runtime_injection (tenant)`
- The tenant is available but not used in the query

---

## Why AI Usually Misses This

- `Task::find($id)` looks like correct code — it's a standard Laravel pattern
- Authorization IS present and correctly checks permissions
- The bug requires understanding the **intersection** of:
  1. Tenant context propagation (middleware → container → query)
  2. Query scope completeness
  3. Authorization ≠ isolation
- Global scopes add further ambiguity — bug may be absent if `Task` has a registered `TenantScope`

---

## Severity

**CRITICAL** — Cross-tenant data exposure. Any tenant user can read (and potentially
write) any other tenant's data by enumerating IDs. Affects all multi-tenant SaaS
applications using this pattern.

---

## Fix Patterns

**Option A — Explicit where clause:**
```php
$tenant = app('tenant');
$task = Task::where('tenant_id', $tenant->id)->findOrFail($id);
```

**Option B — Global scope on model:**
```php
// In Task::booted()
protected static function booted(): void
{
    static::addGlobalScope(new TenantScope);
}
// Now Task::find($id) automatically scopes to current tenant
```

**Option C — Scoped route model binding:**
```php
// In AppServiceProvider::boot()
Route::bind('task', fn($id) =>
    Task::where('tenant_id', app('tenant')->id)->findOrFail($id)
);
// Route {task} parameter is auto-resolved with tenant scope
```

---

## Related Ontology Primitives

- `TenantContext` — resolved by ResolveTenant, injected via `app()->instance('tenant', ...)`
- `UnscopedQuery` — `Task::find($id)` without tenant constraint
- `TenantBoundaryViolation` — structural gap between tenant context and query scope
- `GlobalScopeAssumption` — uncertainty: Task model may have global TenantScope

---

## Related Cases

- LARAVEL-ISO-002 (planned): Cross-tenant write via unscoped relationship
- LARAVEL-TXN-001: Event dispatched before transaction commit

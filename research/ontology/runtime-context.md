# Semantic Primitive: Runtime Context

## Primitives

### RuntimeInjection
A node that writes a value into the service container during request lifecycle,
making it available to downstream components without explicit parameter passing.

**Properties:**
- `key`: string key used in container (`'tenant'`)
- `value_type`: type of injected value (`Tenant`)
- `injected_by`: middleware or service provider
- `mechanism`: `app()->instance()` | `app()->bind()` | `app()->singleton()`

**Laravel manifestation:**
```php
app()->instance('tenant', $tenant);
```

**Static analysis gap:** The injection is only traceable by knowing the
middleware execution order — not visible in the consuming class.

---

### RuntimeConsume
A node that reads a value from the service container that was injected
by a `RuntimeInjection` node earlier in the same request lifecycle.

**Properties:**
- `key`: same string key as the injection
- `consumer`: class/method reading the value
- `edge_type`: RUNTIME_EDGE (not statically traceable)

**Laravel manifestation:**
```php
$tenant = app('tenant');
```

---

### ImplicitContract
A dependency relationship between two execution nodes where:
1. One node injects a value (`RuntimeInjection`)
2. Another node consumes it (`RuntimeConsume`)
3. No static type system or interface enforces the relationship

**Properties:**
- `injector`: node responsible for providing the value
- `consumers`: list of nodes that depend on the value
- `enforcement`: route group placement | middleware order
- `failure_mode`: null value at runtime, no compile error

**Detection rule:**
- `app()->instance(KEY)` in one node
- `app(KEY)` in downstream node(s)
- Same request lifecycle (same route group)

**Known cases:** LARAVEL-RUNTIME-001

---

### TenantContext
A specific `ImplicitContract` pattern where a tenant identifier is
resolved from request input and propagated via service container
to all downstream handlers.

**Properties:**
- `resolution_source`: header | subdomain | path segment
- `injection_key`: `'tenant'` (or similar)
- `scope`: all routes within middleware group

**Laravel manifestation in this project:**
- Source: `X-Tenant-ID` request header
- Resolver: `ResolveTenant` middleware
- Key: `'tenant'`
- Consumers: `TaskController`, `RequireFeature`, likely others

---

### ContainerResolution
A broader primitive covering any case where a class or value is resolved
from the Laravel service container dynamically, making the dependency
invisible to static analysis tools.

**Subtypes:**
- `RuntimeInjection` / `RuntimeConsume` — instance binding
- Dynamic class resolution: `app()->make($dynamicClass)`
- Interface binding: `app()->bind(Interface::class, Concrete::class)`

**Detection difficulty:** HIGH — requires either runtime traces or
framework-specific heuristics (e.g. `app('key')` pattern matching).

---

### ImplicitModelResolution
A hidden execution step where a route parameter is automatically resolved
into a model instance via framework-level binding, executing a DB query
with no explicit code in the controller.

**Properties:**
- `param`: route parameter name, e.g. `{task}`
- `model`: resolved model class, e.g. `Task`
- `binding_type`: `implicit` | `explicit` | `scoped`
- `scope`: optional query constraint (e.g. scoped to tenant)

**Laravel manifestation:**
```php
// Route definition
Route::put('/tasks/{task}', [TaskController::class, 'update']);

// Controller — no explicit query, model is already resolved
public function update(Task $task) { ... }
```

**Hidden execution chain:**
```
route param {task}
  → Router::resolveBinding()
  → implicit DB query: Task::find($id) or Task::where(...)->findOrFail($id)
  → hydrated Task model injected into controller
```

**Semantic relevance:**
- Authorization: policy subject IS the resolved model
- Tenant isolation: scoped binding can enforce tenant boundary
- Ownership: `task->created_by` only available after resolution
- Implicit DB access: hidden query not visible in controller code

**Static analysis gap:** The DB query is implicit — only the framework
knows which model and scope to apply. Scoped bindings (e.g. tenant-scoped)
are defined in `AppServiceProvider`, not at the route or controller level.

**Detection rule:**
- Controller method has type-hinted model parameter matching route param name
- No explicit `find()` or `where()` before first model usage

**Known cases:** Not yet in corpus — `tenant-workspace-api` uses manual `$id`
resolution via `taskService->getTask()` instead of implicit binding.
Future fixture needed.

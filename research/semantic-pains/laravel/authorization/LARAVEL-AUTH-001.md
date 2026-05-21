---
id: LARAVEL-AUTH-001
framework: laravel
category: execution-overlap
difficulty: medium
entrypoint: PUT /tasks/{id}
expected_nodes:
  - auth:sanctum
  - ResolveTenant
  - CheckPermission
  - TaskController::update
  - UpdateTaskRequest::authorize
  - TaskPolicy::update
expected_edges:
  - CheckPermission -> permissionService::hasPermission (TASK_UPDATE)
  - TaskPolicy::update -> permissionService::hasPermission (TASK_UPDATE)
semantic_primitives:
  - AuthorizationCheck
  - ExecutionOverlap
  - TenantContext
  - PolicyResolution
overlap_detected: true
golden_trace: golden-traces/laravel/LARAVEL-AUTH-001.yaml
source_project: tenant-workspace-api
---

# LARAVEL-AUTH-001 — Duplicate Permission Check on Task Update

## Symptom

`TASK_UPDATE` permission is checked twice on the same request execution path.
Neither check is redundant — they serve slightly different purposes — but an AI
cannot explain this without tracing the full execution chain.

## Trigger Query

```
Why is permission checked twice when updating a task?
```

or:

```
Trace the authorization flow for PUT /tasks/{id}
```

## Ground Truth Execution Path

```
PUT /tasks/{id}

auth:sanctum
  ↓
ResolveTenant::handle()
  → reads X-Tenant-ID header
  → Tenant::find($tenantId)
  → app()->instance('tenant', $tenant)
  ↓
CheckPermission::handle('task.update')
  → permissionService->hasPermission(user, TASK_UPDATE, tenant->id)   ← CHECK #1
  ↓
TaskController::update(UpdateTaskRequest, $id)
  → UpdateTaskRequest::authorize() → true (no-op)
  → UpdateTaskRequest::rules() → validate fields
  → taskService->getTask(tenant->id, id)
  → $this->authorize('update', $task)
      → TaskPolicy::update(user, task)
          → permissionService->hasPermission(user, TASK_UPDATE, task->tenant_id)  ← CHECK #2 (DUPLICATE)
          → task->created_by === user->id   ← extra ownership check (not in middleware)
  → taskService->updateTask(task, data)
```

## Why Current AI Fails

- Semantic search returns `CheckPermission.php` + `TaskPolicy.php` as separate
  files with no awareness they are on the same execution path
- AI cannot detect that `tenant->id` in middleware and `task->tenant_id` in policy
  refer to the same value resolved by `ResolveTenant`
- AI does not know that `$this->authorize()` in controller triggers `TaskPolicy`

## Expected ArchMind Output

```
Execution graph for PUT /tasks/{id}:

Middleware chain:
  [1] auth:sanctum
  [2] ResolveTenant → injects app('tenant')
  [3] CheckPermission('task.update') → hasPermission(TASK_UPDATE)   ← CHECK #1

Controller: TaskController@update
  FormRequest: UpdateTaskRequest (authorize: passthrough)
  Policy call: $this->authorize('update', $task) → TaskPolicy::update()
    → hasPermission(TASK_UPDATE)   ← CHECK #2 DUPLICATE
    → ownership check: task->created_by === user->id

⚠ OVERLAP DETECTED:
  CheckPermission (middleware) and TaskPolicy::update (policy)
  both call permissionService->hasPermission for TASK_UPDATE.
```

## Token Comparison (estimated)

| Approach | Files injected | Token estimate |
|---|---|---|
| Naive RAG | CheckPermission, TaskPolicy, TaskController, PermissionService, routes/task.php, UpdateTaskRequest | ~18k |
| ArchMind | Execution graph nodes only (6 nodes, 5 edges) | ~2k |

## Files Involved

- `routes/api.php`
- `routes/api/task.php`
- `app/Http/Middleware/CheckPermission.php`
- `app/Http/Middleware/ResolveTenant.php`
- `app/Modules/Task/Http/Controllers/TaskController.php`
- `app/Modules/Task/Requests/UpdateTaskRequest.php`
- `app/Policies/TaskPolicy.php`
- `app/Modules/Access/Services/PermissionService.php`

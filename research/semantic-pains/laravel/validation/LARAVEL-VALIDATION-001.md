---
id: LARAVEL-VALIDATION-001
framework: laravel
category: delegated-authorization
difficulty: medium
entrypoint: PUT /tasks/{id}
expected_nodes:
  - UpdateTaskRequest::authorize
  - CheckPermission
  - TaskPolicy::update
expected_edges:
  - UpdateTaskRequest::authorize -> true (passthrough)
  - CheckPermission -> TASK_UPDATE (real auth layer 1)
  - TaskPolicy::update -> TASK_UPDATE + ownership (real auth layer 2)
semantic_primitives:
  - DelegatedAuthorization
  - AuthorizationCheck
  - ValidationBoundary
  - LayeredSecurity
pattern: authorization-delegated-to-middleware-and-policy
golden_trace: golden-traces/laravel/LARAVEL-VALIDATION-001.yaml
source_project: tenant-workspace-api
---

# LARAVEL-VALIDATION-001 — FormRequest authorize() is a Passthrough

## Symptom

`UpdateTaskRequest::authorize()` returns `true` unconditionally. The actual
authorization is handled by middleware (`CheckPermission`) and policy
(`TaskPolicy`). An AI reading the FormRequest in isolation will either conclude
there is no authorization, or flag it as a missing check — both are wrong.

## Trigger Query

```
Is there authorization on the task update endpoint?
```

or:

```
Why does UpdateTaskRequest::authorize() return true?
```

or:

```
Where is authorization enforced for UpdateTaskRequest?
```

## Ground Truth

### What AI sees first

```php
public function authorize(): bool
{
    return true;   // ← looks like no auth
}
```

### Actual authorization (split across layers)

```
Layer 1 — Route middleware:
  CheckPermission('task.update')
  → permissionService->hasPermission(user, TASK_UPDATE, tenant->id)

Layer 2 — Controller policy:
  $this->authorize('update', $task) → TaskPolicy::update()
  → permissionService->hasPermission(user, TASK_UPDATE, task->tenant_id)
  → task->created_by === user->id
```

### Architectural decision

FormRequest = validation only. Authorization fully delegated upstream.
Pattern is consistent across all task FormRequests in this codebase.

## Pattern Across Codebase

| FormRequest | authorize() | Actual auth |
|---|---|---|
| CreateTaskRequest | `return true` | CheckPermission + TaskPolicy::create |
| UpdateTaskRequest | `return true` | CheckPermission + TaskPolicy::update |
| CreateCommentRequest | `return true` | CheckPermission + TaskCommentPolicy |
| StoreAttachmentRequest | `return true` | CheckPermission + TaskAttachmentPolicy |

## Why Current AI Fails

- AI sees `return true` → concludes no auth or flags as missing check (false positive)
- Cannot determine whether `return true` is intentional design or oversight
  without seeing the full execution chain
- Semantic search returns FormRequest + Policy with no ordering or delegation info

## Expected ArchMind Output

```
Authorization flow for PUT /tasks/{id}:

FormRequest::authorize() → true (passthrough — intentional)

Actual authorization upstream:
  [1] CheckPermission middleware → TASK_UPDATE check
  [2] TaskPolicy::update → TASK_UPDATE + ownership check

Pattern: FormRequest = validation boundary only.
Authorization delegated to middleware + policy layers.
Consistent across all 4 task FormRequests.

No missing authorization — design is intentional.
```

## Token Comparison (estimated)

| Approach | Files injected | Token estimate |
|---|---|---|
| Naive RAG | UpdateTaskRequest, TaskPolicy, CheckPermission, TaskController | ~15k |
| ArchMind | Authorization layer graph (3 nodes, delegation annotation) | ~1k |

## Files Involved

- `app/Modules/Task/Requests/UpdateTaskRequest.php`
- `app/Modules/Task/Requests/CreateTaskRequest.php`
- `app/Http/Middleware/CheckPermission.php`
- `app/Modules/Task/Http/Controllers/TaskController.php`
- `app/Policies/TaskPolicy.php`

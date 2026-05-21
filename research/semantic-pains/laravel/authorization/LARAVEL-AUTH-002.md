---
id: LARAVEL-AUTH-002
framework: laravel
category: semantic-ambiguity
difficulty: high
entrypoint: DELETE /tasks/{id}
expected_nodes:
  - auth:sanctum
  - ResolveTenant
  - CheckPermission
  - TaskController::destroy
  - TaskPolicy::delete
  - PermissionService::hasPermission (TASK_DELETE)
  - PermissionService::hasPermission (TASK_DELETE_ANY)
expected_edges:
  - TaskPolicy::delete -> hasPermission(TASK_DELETE)
  - TaskPolicy::delete -> hasPermission(TASK_DELETE_ANY)
  - TASK_DELETE_ANY -> TASK_DELETE (privilege hierarchy)
semantic_primitives:
  - AuthorizationCheck
  - PrivilegeHierarchy
  - OwnershipConstraint
  - PolicyResolution
bug_detected: true
golden_trace: golden-traces/laravel/LARAVEL-AUTH-002.yaml
source_project: tenant-workspace-api
---

# LARAVEL-AUTH-002 — Inverted Logic in TaskPolicy::delete()

## Symptom

`TaskPolicy::delete()` has inverted conditional logic for `TASK_DELETE_ANY` permission.
The code compiles and runs without error, but the behavior is opposite to intent.
An AI doing code review will likely miss this without understanding the RBAC semantics.

## Trigger Query

```
Review the delete authorization logic for tasks
```

or:

```
Can a user with TASK_DELETE_ANY permission delete any task?
```

## Ground Truth

### Current code (`app/Policies/TaskPolicy.php:47-68`)

```php
public function delete(User $user, Task $task): bool
{
    if (!$this->permissionService->hasPermission($user, Permission::TASK_DELETE, $task->tenant_id)) {
        return false;
    }

    // BUG — condition is inverted
    if (!$this->permissionService->hasPermission($user, Permission::TASK_DELETE_ANY, $task->tenant_id)) {
        return true;   // ← no TASK_DELETE_ANY → allow delete (wrong intent)
    }

    return $task->created_by === $user->id;  // ← has TASK_DELETE_ANY → only own task (backwards)
}
```

### Intended behavior (based on RBAC design)

```
TASK_DELETE_ANY = elevated permission = can delete any task
TASK_DELETE     = basic permission    = can only delete own tasks
```

### Correct logic

```php
public function delete(User $user, Task $task): bool
{
    if (!$this->permissionService->hasPermission($user, Permission::TASK_DELETE, $task->tenant_id)) {
        return false;
    }

    if ($this->permissionService->hasPermission($user, Permission::TASK_DELETE_ANY, $task->tenant_id)) {
        return true;  // elevated: can delete any task
    }

    return $task->created_by === $user->id;  // basic: only own tasks
}
```

## Why Current AI Fails

- Permission names are string constants — their privilege relationship is defined
  in `Permission.php` + `RBACSeeder.php`, not in the policy itself
- AI sees the condition but cannot infer that `TASK_DELETE_ANY` is semantically
  higher privilege than `TASK_DELETE` without tracing the RBAC graph
- Without the privilege hierarchy edge, the bug is invisible

## Expected ArchMind Output

```
⚠ LOGIC BUG DETECTED in TaskPolicy::delete():

RBAC hierarchy: TASK_DELETE_ANY (elevated) > TASK_DELETE (basic)

Current behavior:
  user WITHOUT TASK_DELETE_ANY → allowed to delete (returns true)
  user WITH TASK_DELETE_ANY    → restricted to own tasks only

This is inverted. Users with elevated privilege are MORE restricted.

Suggested fix: invert the TASK_DELETE_ANY condition (line 57).
```

## Token Comparison (estimated)

| Approach | Files injected | Token estimate |
|---|---|---|
| Naive RAG | TaskPolicy, Permission constants, PermissionService, RBACSeeder | ~20k |
| ArchMind | RBAC hierarchy graph + policy node (4 nodes, 3 edges) | ~1.5k |

## Files Involved

- `app/Policies/TaskPolicy.php`
- `app/Common/Constants/Permission.php`
- `app/Modules/Access/Services/PermissionService.php`
- `app/Modules/Access/Models/RolePermission.php`
- `database/seeders/RBACSeeder.php`

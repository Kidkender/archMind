# Semantic Primitive: Authorization

## Primitives

### AuthorizationCheck
A node in the execution graph where a user's permission is evaluated.

**Properties:**
- `permission`: the permission constant being checked
- `subject`: user performing the action
- `scope`: tenant/resource scope of the check
- `layer`: middleware | policy | gate | form_request

**Laravel manifestations:**
- `CheckPermission` middleware → `permissionService->hasPermission()`
- `$this->authorize()` in controller → Policy method
- `FormRequest::authorize()` → inline check or passthrough

---

### ExecutionOverlap
Two or more `AuthorizationCheck` nodes checking the same permission
on the same execution path for the same request.

**Detection rule:**
- Same `permission` value
- Same `subject`
- Same `scope` (or provably equivalent scope)
- Both reachable from same route entrypoint without branching

**Known cases:** LARAVEL-AUTH-001

---

### PrivilegeHierarchy
A semantic relationship between two permission constants where one
represents elevated access over the other.

**Properties:**
- `elevated`: permission with broader access
- `basic`: permission with restricted access
- `relationship`: elevated > basic

**Detection rule:**
- Permission naming convention: `*_ANY` suffix = elevated over base
- Seeder data: role-permission assignments imply hierarchy

**Known cases:** LARAVEL-AUTH-002 (`TASK_DELETE_ANY` > `TASK_DELETE`)

---

### OwnershipConstraint
An authorization condition that restricts an action to the resource's
creator or owner.

**Properties:**
- `ownership_field`: e.g. `created_by`, `user_id`
- `subject_field`: e.g. `user->id`

**Laravel manifestation:**
```php
return $task->created_by === $user->id;
```

---

### PolicyResolution
The process by which Laravel resolves a policy class and method
from a `$this->authorize()` call in a controller.

**Resolution chain:**
```
$this->authorize('update', $task)
  → Gate::authorize('update', Task::class)
  → AppServiceProvider policy registration
  → TaskPolicy::update(user, task)
```

**Key insight:** The link between `$this->authorize()` and the Policy class
is defined in `AppServiceProvider` or auto-discovered — not visible at the
call site. This is a static analysis gap.

---

### DelegatedAuthorization
An authorization layer that intentionally passes all checks to upstream layers.

**Laravel manifestation:**
```php
// FormRequest::authorize()
public function authorize(): bool { return true; }
```

**Detection rule:** `authorize()` returns literal `true` AND upstream middleware
or controller contains `AuthorizationCheck` nodes for the same route.

**Known cases:** LARAVEL-VALIDATION-001

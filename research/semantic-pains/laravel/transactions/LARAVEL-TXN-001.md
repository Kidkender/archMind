# LARAVEL-TXN-001: Event Dispatched Before Transaction Commit

## Pain Summary

An event is dispatched synchronously **inside** a `DB::transaction()` block, before the
transaction commits. If the transaction later rolls back (or if a listener reads data
that is not yet visible to other connections), the system enters a permanently inconsistent
state with no compensation path.

This is one of the most common high-severity bugs in Laravel applications at scale.

---

## Scenario

```
POST /tasks  →  TaskController::store()
```

Controller creates a `Task` and dispatches `TaskCreated` inside a transaction:

```php
public function store(StoreTaskRequest $request): JsonResponse
{
    return DB::transaction(function () use ($request) {
        $task = Task::create($request->validated());

        // ← escape: fires before commit
        TaskCreated::dispatch($task);

        $this->auditService->log('task.created', $task);

        return response()->json($task, 201);
    });
}
```

Listener sends an email notification:

```php
class SendTaskCreatedNotification implements ShouldQueue
{
    public function handle(TaskCreated $event): void
    {
        $event->task->assignee->notify(new TaskAssignedNotification($event->task));
    }
}
```

---

## Why This Is a Bug

**Normal path (no rollback):**
1. Transaction opens
2. `Task::create()` — row written (uncommitted)
3. `TaskCreated::dispatch()` — listener queued (or runs sync)
4. `auditService->log()` — audit row written
5. Transaction commits
6. Listener sends email ✓ (data exists, consistent)

**Failure path (rollback):**
1. Transaction opens
2. `Task::create()` — row written (uncommitted)
3. `TaskCreated::dispatch()` — listener queued ← **escape fires here**
4. `auditService->log()` throws `QueryException` (e.g., tenant constraint violation)
5. Transaction rolls back — Task row deleted, audit row deleted
6. **Listener still executes** — reads a task that no longer exists
7. Email sent to assignee for a task that was never created ← **permanent inconsistency**

---

## Execution Graph Shape

```
POST /tasks
  └─ TaskController::store
       └─ [TransactionBoundary: open]
            ├─ Task::create          (TransactionalWrite)
            ├─ TaskCreated::dispatch (TransactionEscape ← danger)
            │    └─ SendTaskCreatedNotification::handle
            │         └─ Notification::send (escapes_transaction edge)
            └─ AuditService::log     (TransactionalWrite)
       └─ [TransactionBoundary: commit | rollback]
```

**Critical edges:**
- `TaskCreated::dispatch` → `escapes_transaction` → `[TransactionBoundary: open]`
- `Notification::send` → `within_transaction: false` but reachable from inside scope

---

## Why AI Usually Misses This

- The event dispatch *looks* like a normal service call at the AST level
- The danger is in the **temporal ordering**: dispatch happens before commit
- Requires understanding of: (1) Laravel event lifecycle, (2) transaction isolation, (3) queue execution timing
- Static analysis without transaction graph primitives cannot reason about this

---

## Severity

**HIGH** — Data integrity violation. Frequency: common in Laravel monoliths handling multi-step resource creation.

---

## Fix Patterns

**Option A — `ShouldHandleEventsAfterCommit` (Laravel 8+):**
```php
class SendTaskCreatedNotification implements ShouldQueue, ShouldHandleEventsAfterCommit
{
    // Laravel will defer this until after the outermost transaction commits
}
```

**Option B — Dispatch outside transaction:**
```php
public function store(StoreTaskRequest $request): JsonResponse
{
    $task = DB::transaction(function () use ($request) {
        $task = Task::create($request->validated());
        $this->auditService->log('task.created', $task);
        return $task;
    });

    TaskCreated::dispatch($task);  // ← safe: fired after commit

    return response()->json($task, 201);
}
```

**Option C — afterCommit callback (Laravel 10+):**
```php
DB::transaction(function () use ($request) {
    $task = Task::create($request->validated());
    DB::afterCommit(fn() => TaskCreated::dispatch($task));
    $this->auditService->log('task.created', $task);
});
```

---

## Related Ontology Primitives

- `TransactionBoundary` — wraps the DB::transaction block
- `TransactionalWrite` — Task::create, AuditService::log
- `TransactionEscape` — TaskCreated::dispatch (fires before commit)
- `RollbackPropagation` — triggered by QueryException in auditService
- `AtomicityScope` — the closure passed to DB::transaction

---

## Related Cases

- LARAVEL-TXN-002 (planned): Missing transaction on multi-step write
- LARAVEL-TXN-003 (planned): Queue push inside transaction with database queue driver

# Semantic Primitive: Transaction

## Overview

Transaction semantics describe the **atomic execution boundaries** around database operations.
A transaction guarantees that a set of writes either all succeed (commit) or all fail (rollback) together.

In the execution graph, a transaction creates an **AtomicityScope** — a subgraph where all
enclosed writes are semantically bound. The critical insight is that **side effects that escape
the scope** (events, HTTP calls, cache writes, queue pushes) are **not rolled back** when the
transaction fails. This is the primary source of transaction-related consistency bugs.

---

## Primitives

### TransactionBoundary

A node marking the open or close of a database transaction.

**Properties:**
- `boundary_type`: `open` | `commit` | `rollback` | `savepoint`
- `scope_id`: links open/commit/rollback nodes belonging to the same transaction
- `nesting_level`: `0` = outermost, `1+` = savepoint or nested transaction

**Laravel manifestations:**
```php
DB::transaction(function () { ... });  // implicit open + commit + rollback on exception
DB::beginTransaction();                // explicit open
DB::commit();                          // explicit commit
DB::rollBack();                        // explicit rollback
```

---

### TransactionalWrite

A write operation (INSERT, UPDATE, DELETE) that occurs inside a TransactionBoundary.

**Properties:**
- `model`: Eloquent model class being written
- `operation`: `create` | `update` | `delete` | `upsert`
- `scope_id`: the AtomicityScope this write belongs to

**Laravel manifestations:**
```php
Task::create([...]);         // inside DB::transaction()
$task->update([...]);
$task->delete();
DB::table('tasks')->insert([...]);
```

**Detection rule:** Any model write call reachable inside a `DB::transaction()` closure
or between `DB::beginTransaction()` and `DB::commit()`.

---

### TransactionEscape

A side effect that executes **inside** an AtomicityScope but is **not** protected by
the transaction's rollback guarantee.

**Escape types:**

| Type | Example | Risk |
|---|---|---|
| `event_dispatch` | `TaskCreated::dispatch($task)` | Listener runs on uncommitted data |
| `queue_push` | `ProcessReport::dispatch()` | Job runs before commit, reads phantom data |
| `http_call` | `$this->http->post(...)` | External system updated, DB rolls back |
| `cache_write` | `Cache::put('task:'.$id, $task)` | Cache reflects state that never committed |
| `notification` | `$user->notify(new TaskAssigned())` | Email sent for a task that doesn't exist |

**Severity:** HIGH — escape side effects execute even if the transaction rolls back,
causing permanent inconsistency between database state and external state.

---

### RollbackPropagation

The semantic consequence when a transaction is rolled back: all TransactionalWrites
in its AtomicityScope are undone, but TransactionEscapes are **not** compensated.

**Properties:**
- `trigger`: `exception` | `explicit_rollback` | `deadlock` | `timeout`
- `affected_writes`: list of TransactionalWrite node ids undone
- `uncompensated_escapes`: list of TransactionEscape node ids that already fired

**Key insight:** The gap between `affected_writes` and `uncompensated_escapes` is the
semantic inconsistency window. This is what ArchMind must surface.

---

### AtomicityScope

The semantic subgraph bounded by a TransactionBoundary pair (open → commit/rollback).
All enclosed nodes share atomicity guarantees.

**Properties:**
- `open_node`: TransactionBoundary of `boundary_type: open`
- `close_node`: TransactionBoundary of `boundary_type: commit | rollback`
- `enclosed_writes`: all TransactionalWrite nodes inside scope
- `enclosed_escapes`: all TransactionEscape nodes inside scope (the danger zone)

---

## Detectable Patterns

### EventBeforeCommit

Event dispatched synchronously inside a transaction before commit.

```php
DB::transaction(function () {
    $task = Task::create([...]);
    TaskCreated::dispatch($task);  // ← escape: fires before commit
    // listener receives model whose DB row may not yet exist to other connections
});
```

**Risk chain:**
1. Listener runs synchronously during transaction — reads uncommitted data
2. Listener makes external call (email, Slack, webhook) assuming data is stable
3. Transaction rolls back (e.g., constraint violation in a later write)
4. External call cannot be undone — system is permanently inconsistent

**Fix options:**
- Add `ShouldHandleEventsAfterCommit` to the listener class
- Move `dispatch()` call after the `DB::transaction()` block
- Use `Event::dispatch()->afterCommit()` if available

**Known cases:** LARAVEL-TXN-001

---

### MissingTransactionBoundary

Multiple semantically related writes executed without a wrapping transaction.

```php
// DANGEROUS: no transaction wrapper
$task    = Task::create([...]);
$history = TaskHistory::create([...]); // if this throws, task row exists but history is missing
```

**Detection rule:**
- 2+ TransactionalWrite nodes on the same execution path targeting related models
- No enclosing TransactionBoundary node
- "Related" inferred from: shared prefix (Task / TaskHistory), foreign key args, same controller action

---

### NestedRollbackSwallowed

Inner transaction throws and rolls back its savepoint, but the exception is caught
and swallowed by the outer scope — leaving the outer transaction in an ambiguous state.

```php
DB::transaction(function () {
    Task::create([...]);
    try {
        DB::transaction(function () {
            AuditLog::create([...]);
            throw new \Exception("inner fail");  // rolls back savepoint
        });
    } catch (\Exception $e) {
        // swallowed — but MySQL already released savepoint, Postgres may deadlock
    }
    // outer commits — AuditLog missing, inconsistent
});
```

**Severity:** HIGH (database-engine dependent — behavior differs between MySQL and Postgres)

---

## Graph Node Types (ontology extension)

These node types extend the existing execution graph ontology:

| `type` | `role` | Description |
|---|---|---|
| `transaction_boundary` | `atomicity` | Open/commit/rollback marker |
| `transactional_write` | `persistence` | DB write inside transaction scope |
| `transaction_escape` | `side_effect` | Non-transactional side effect inside scope |

## Edge Relations (ontology extension)

| `relation` | Meaning |
|---|---|
| `within_transaction` | Node is enclosed by an AtomicityScope |
| `escapes_transaction` | Side effect node fires before commit |
| `triggers_rollback` | Exception node causes rollback of scope |

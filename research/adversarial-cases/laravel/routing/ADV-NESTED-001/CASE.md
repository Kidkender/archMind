# ADV-NESTED-001: Nested Route Groups — Middleware Propagation

## Summary

A route lives inside a doubly-nested group:

```php
Route::middleware(['auth:sanctum'])->group(function () {
    Route::middleware(['tenant'])->prefix('api')->group(function () {
        Route::put('/projects/{project}', [ProjectController::class, 'update']);
    });
});
```

The effective middleware stack is `[auth:sanctum, tenant]` but each group
defines only one layer. The engine must merge parent + child middleware
to reconstruct the full execution path.

## Why This Is Adversarial

A naive single-pass extractor reads the innermost group only and emits:

```
middleware: [tenant]   ← misses auth:sanctum from outer group
```

This causes:
- Missing `authentication_gate` node
- Broken edge chain (no entry before tenant middleware)
- Recall drop on authentication HIGH node

## Fixture

`fixture/routes/api.php` — doubly-nested group with route
`fixture/app/Http/Middleware/ResolveTenant.php` — tenant middleware

## Expected Behavior

Engine should walk the full group ancestry and merge all inherited middleware
into the node sequence before emitting the execution graph.

## Failure Mode

`incomplete_middleware_inheritance` — outer group middleware silently dropped,
authentication node missing from graph.

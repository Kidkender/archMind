# ADV-ALIAS-001: Middleware Alias Resolution

## Summary

A route uses a middleware alias (`role:admin`) that maps to a concrete class
via `$middlewareAliases` in `Kernel.php`. The extraction engine sees the alias
string but cannot resolve it to `EnsureUserHasRole::handle` without reading
the kernel registration.

## Why This Is Adversarial

Static traversal reads route middleware as `['auth', 'role:admin']`.
Without alias resolution, the engine emits:

```
{ type: "middleware", symbol: "role:admin" }   ← alias, not real symbol
```

instead of:

```
{ type: "authorization_check", symbol: "EnsureUserHasRole::handle", args: ["admin"] }
```

This causes:
- Recall miss on a HIGH relevance node
- Wrong node type (`middleware` vs `authorization_check`)
- Serializer shows stub instead of semantic meaning

## Fixture

`fixture/routes/api.php` — route with `role:admin` middleware
`fixture/app/Http/Kernel.php` — alias registration
`fixture/app/Http/Middleware/EnsureUserHasRole.php` — concrete class

## Expected Behavior

Engine should resolve alias → concrete class → correct node type + symbol.

## Failure Mode

`unresolved_middleware_alias` — engine emits alias string as symbol,
misses authorization semantic, recall drops on HIGH nodes.

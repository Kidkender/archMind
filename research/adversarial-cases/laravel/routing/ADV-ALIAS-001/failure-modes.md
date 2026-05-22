# ADV-ALIAS-001 Failure Modes

## Primary Failure: unresolved_middleware_alias

**Trigger**: Route declares `role:admin` middleware string.

**Engine behavior (current)**:
```
node: { id: "role_admin", type: "middleware", symbol: "role:admin" }
```

**Correct behavior**:
```
node: { id: "role_admin", type: "authorization_check", symbol: "EnsureUserHasRole::handle", args: ["admin"] }
```

**Impact**:
- Node type wrong → wrong relevance classification (middleware=MEDIUM vs authorization_check=HIGH)
- Symbol unresolvable → serializer cannot show semantic meaning
- R1 pruning keeps wrong node, drops correct one

## Secondary Failure: args not parsed

Alias `role:admin` carries parameter `admin`. Even if alias resolves to class,
engine may drop the `args: ["admin"]` — losing the role constraint context.

## Fix Path

1. Extract `$middlewareAliases` map from `app/Http/Kernel.php`
2. On route middleware string, check if it matches an alias key
3. If match: replace symbol with alias value (class name), parse colon-separated args
4. Re-classify node type based on resolved class (check against known patterns)

## Required Capability

`kernel_alias_resolution` — reads Kernel.php, builds alias→class map, resolves at extraction time.

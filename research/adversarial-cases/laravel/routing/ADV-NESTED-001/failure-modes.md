# ADV-NESTED-001 Failure Modes

## Primary Failure: incomplete_middleware_inheritance

**Trigger**: Route is inside nested `Route::group()` calls with middleware at each level.

**Engine behavior (current)**:
Processes innermost group → emits only `tenant` middleware.
`auth:sanctum` from outer group is never seen.

**Correct behavior**:
Walk group ancestry, merge all middleware arrays in order (outer → inner), then emit.

**Impact**:
- `authentication_gate` node (auth:sanctum) missing entirely
- First edge of chain starts at `ResolveTenant` — no authentication predecessor
- Recall drops significantly on HIGH nodes

## Secondary Failure: prefix not applied to entrypoint

Inner group adds `prefix('api')` — without merging, entrypoint stored as `/projects/{project}`
instead of `/api/projects/{project}`. Route matching fails for retrieval.

## Fix Path

1. When parsing a route, collect the full group ancestry stack
2. Merge `middleware` arrays: outer group first, inner group appended
3. Merge `prefix` values: concatenate in order
4. Emit merged result as effective route config before node extraction

## Required Capability

`recursive_group_middleware_merge` — stack-based group inheritance resolver
applied before node extraction.

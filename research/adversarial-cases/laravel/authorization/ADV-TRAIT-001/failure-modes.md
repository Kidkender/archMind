# ADV-TRAIT-001 Failure Modes

## Primary Failure: unresolved_trait_dispatch

**Trigger**: Controller uses trait `HasProjectScope` that overrides `authorize()`.

**Engine behavior (current)**:
Sees `$this->authorize('update', $project)` → emits direct `policy_check` edge
to `ProjectPolicy::update`. Trait interception invisible.

**Correct behavior**:
Detect that `HasProjectScope` overrides `authorize()` → emit intermediate
`authorization_check` node for `HasProjectScope::authorize`, then edge to policy.

**Impact**:
- `ownership_check` node missing entirely
- Edge semantics wrong: controller→policy instead of controller→ownership→policy
- High-severity authorization gate invisible to any downstream reasoning

## Why This Is Hard

PHP trait method resolution requires:
1. Detect `use HasProjectScope` in class body
2. Read trait file
3. Check if trait defines method with same name as called method (`authorize`)
4. If yes: emit intermediate node, re-route edge

This is a second-pass analysis on top of the primary extraction.

## Secondary Failure: wrong edge traceability

Even if engine detects trait, it may emit edge as `traceability: static` when
it should be `traceability: semantic` (trait dispatch is not always statically obvious).

## Fix Path

1. During controller extraction: collect `use TraitName` declarations
2. For each `$this->method()` call: check if any used trait overrides that method
3. If override found: insert intermediate node, adjust edges
4. Mark edge as `traceability: semantic`

## Required Capability

`trait_method_override_detection` — two-pass extraction with trait resolution layer.

## Scope Boundary

This capability is in-scope. More complex trait scenarios (trait-of-trait, conflict resolution,
insteadOf/as aliases) are out of scope and listed in `unsupported-semantics.yaml`.

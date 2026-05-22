# Adversarial Cases

Tests extraction **robustness** against real-world framework indirection.

Distinct from semantic pains (which test *usefulness*) — these test whether
the engine survives framework mechanics that defeat static reasoning.

## Structure

```
adversarial-cases/
  unsupported-semantics.yaml     ← explicit registry of known limitations
  laravel/
    routing/
      ADV-ALIAS-001/             ← middleware alias resolution
      ADV-NESTED-001/            ← nested route group middleware inheritance
    authorization/
      ADV-TRAIT-001/             ← trait-injected controller authorization
```

Each case contains:
- `CASE.md` — what it tests and why it's adversarial
- `fixture/` — minimal PHP files that reproduce the scenario
- `expected.yaml` — ground truth graph with `expected_failure` annotations
- `failure-modes.md` — how the engine fails and the fix path

## Failure Taxonomy

| Type | Description | Severity |
|------|-------------|----------|
| `unresolved_middleware_alias` | Alias string not resolved to concrete class | MEDIUM |
| `incomplete_middleware_inheritance` | Outer group middleware dropped | MEDIUM |
| `unresolved_trait_dispatch` | Trait method override invisible to extractor | MEDIUM |

## Coverage Frontier

See `unsupported-semantics.yaml` for explicit out-of-scope boundaries.

Current in-scope adversarial capabilities targeted:
1. `kernel_alias_resolution` — ADV-ALIAS-001
2. `recursive_group_middleware_merge` — ADV-NESTED-001
3. `trait_method_override_detection` — ADV-TRAIT-001

## Dashboard

| Case | Status | Expected Recall | Failure Type |
|------|--------|-----------------|--------------|
| ADV-ALIAS-001 | known-fail | 0.33 | unresolved_middleware_alias |
| ADV-NESTED-001 | known-fail | 0.33 | incomplete_middleware_inheritance |
| ADV-TRAIT-001 | known-fail | 0.25 | unresolved_trait_dispatch |

# Semantic Ontology

Formal definitions of semantic primitives discovered during Phase 0 research.
These primitives are the abstract vocabulary that ArchMind's graph engine
operates on — framework-agnostic concepts mapped from concrete code patterns.

## Purpose

Bridge between:
- **Concrete** — `app()->instance('tenant', $tenant)` in Laravel
- **Abstract** — `RuntimeInjection { key: 'tenant', injected_by: ResolveTenant }`

This allows cross-framework reasoning:
```
Laravel:  app()->instance('tenant')  → RuntimeInjection
NestJS:   REQUEST-scoped provider    → RuntimeInjection
Spring:   @RequestScope bean         → RuntimeInjection
```

## Primitive Index

### Authorization
| Primitive | Description | File |
|---|---|---|
| `AuthorizationCheck` | Permission evaluation node | [authorization.md](./authorization.md) |
| `ExecutionOverlap` | Duplicate check on same path | [authorization.md](./authorization.md) |
| `PrivilegeHierarchy` | Elevated vs basic permission | [authorization.md](./authorization.md) |
| `OwnershipConstraint` | Creator/owner restriction | [authorization.md](./authorization.md) |
| `PolicyResolution` | Laravel policy dispatch chain | [authorization.md](./authorization.md) |
| `DelegatedAuthorization` | Intentional passthrough | [authorization.md](./authorization.md) |

### Runtime Context
| Primitive | Description | File |
|---|---|---|
| `RuntimeInjection` | Value written to container | [runtime-context.md](./runtime-context.md) |
| `RuntimeConsume` | Value read from container | [runtime-context.md](./runtime-context.md) |
| `ImplicitContract` | Unenforced dependency between nodes | [runtime-context.md](./runtime-context.md) |
| `TenantContext` | Tenant propagation via container | [runtime-context.md](./runtime-context.md) |
| `ContainerResolution` | Dynamic service resolution | [runtime-context.md](./runtime-context.md) |
| `ImplicitModelResolution` | Route param → model via hidden DB query | [runtime-context.md](./runtime-context.md) |

## How to Add a Primitive

When a new pain case requires a concept not in this index:
1. Check if an existing primitive covers it (with a variant)
2. If not, add it to the relevant category file
3. Update the index in this README
4. Reference the primitive in the pain file's frontmatter `semantic_primitives`

## Edge Type Registry

| Edge Type | Description | Traceability |
|---|---|---|
| `next_middleware` | Middleware chain order | `static` |
| `form_request` | Controller → FormRequest binding | `static` |
| `calls` | Direct method call | `static` |
| `policy_check` | `$this->authorize()` → Policy method | `semantic` |
| `privilege_hierarchy` | Permission level relationship | `semantic` |
| `implicit_model_resolution` | Route param → hydrated model | `semantic` |
| `runtime_inject` | `app()->instance()` container write | `runtime` |
| `runtime_consume` | `app('key')` container read | `runtime` |
| `semantic_equivalence` | Two values provably same (e.g. tenant->id == task->tenant_id) | `probabilistic` |

**Traceability levels:**
- `static` — derivable from AST alone
- `semantic` — requires framework ontology knowledge
- `runtime` — requires execution traces / OpenTelemetry
- `probabilistic` — heuristic inference only, confidence < 1.0

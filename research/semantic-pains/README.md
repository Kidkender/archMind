# Semantic Pains — Benchmark Corpus

Research-grade benchmark corpus for validating ArchMind's core hypothesis:

> execution-aware retrieval > naive semantic retrieval

## Structure

```
semantic-pains/
  laravel/
    authorization/    execution overlap, policy logic, auth delegation
    runtime/          hidden contracts, container injection, implicit deps
    queues/           async side effects, event chains (coming soon)
    validation/       FormRequest patterns, delegation
  nestjs/             (future)
  spring/             (future)
```

## Pain Taxonomy

| Category | Definition | Example |
|---|---|---|
| `execution-overlap` | Same logic appears at multiple points in one execution path | Permission checked in middleware AND policy |
| `runtime-dependency` | Value injected at runtime with no static trace | `app('tenant')` from middleware |
| `delegated-authorization` | Auth responsibility split across layers, invisible at each layer | `FormRequest::authorize() → true` |
| `semantic-ambiguity` | Code behavior contradicts its apparent intent | Inverted privilege condition |
| `async-side-effect` | Hidden queue/event triggered by an action | Task assigned → notification queued |
| `container-resolution` | Service resolved dynamically, static analysis cannot follow | `app()->make($abstract)` |

## Benchmark Format

Each pain file contains:

| Field | Purpose |
|---|---|
| Frontmatter (`id`, `category`, `expected_nodes`, etc.) | Machine-readable for automated benchmark runs |
| **Trigger Query** | What a developer would ask |
| **Ground Truth Execution Path** | Correct answer — full chain |
| **Why Current AI Fails** | Concrete failure mode of naive RAG |
| **Expected ArchMind Output** | Engine target output |
| **Token Comparison** | Naive RAG vs ArchMind estimate |

## Current Cases

| ID | File | Category | Difficulty |
|---|---|---|---|
| pain-01 | `laravel/authorization/pain-01-duplicate-permission-check.md` | execution-overlap | medium |
| pain-02 | `laravel/authorization/pain-02-inverted-delete-policy-logic.md` | semantic-ambiguity | high |
| pain-03 | `laravel/runtime/pain-03-hidden-tenant-runtime-dependency.md` | runtime-dependency | high |
| pain-04 | `laravel/validation/pain-04-formrequest-authorize-passthrough.md` | delegated-authorization | medium |

## How to Run Benchmark

```bash
# Future CLI — not yet implemented
duck benchmark run --framework=laravel --category=authorization
duck benchmark run --id=pain-01
duck benchmark run --all --output=results/baseline.json
```

## Benchmark Metrics

| Metric | Target | How to Measure |
|---|---|---|
| Retrieval precision | > naive RAG | % of expected_nodes correctly retrieved |
| Token reduction | 50–90% | tokens(ArchMind) / tokens(naive RAG) |
| Hallucination rate | lower than naive | fabricated nodes / total nodes in output |
| Latency | < 2–3s | wall time from query to retrieval result |

## Source Projects

| Project | Framework | Notes |
|---|---|---|
| `tenant-workspace-api` | Laravel 11 | Multi-tenant workspace, custom RBAC, Sanctum |

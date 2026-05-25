# @archmind/explainer

**Detects real security and correctness issues in Laravel execution graphs — before asking an LLM a single question.**

---

## Why findings-first matters

Most AI code review tools ask the LLM to "look for problems." The LLM then produces plausible-sounding findings that may or may not be real, with no evidence chain and no way to verify them.

`@archmind/explainer` flips this. It runs deterministic pattern detectors against the structured execution graph and produces concrete, evidence-backed findings first. The LLM then explains and contextualizes findings that are already known to exist — rather than guessing.

The difference: **findings with provenance vs. findings with vibes.**

---

## What it detects

Seven static detectors, each targeting a specific failure pattern in Laravel applications:

| Finding | What it means |
|---|---|
| `missing_authorization` | A controller action has no auth gate, policy check, or permission middleware in its execution path |
| `duplicate_authorization` | The same permission is checked in both middleware *and* a policy — redundant, and a maintenance hazard |
| `delegated_validation` | A FormRequest's `authorize()` calls a policy that re-checks permissions already enforced upstream |
| `hidden_runtime_dependency` | A controller or service uses `app()` to resolve a dependency at runtime — invisible to static analysis and untestable |
| `privilege_hierarchy_present` | Multiple permission levels exist in the path — potential privilege escalation surface |
| `event_before_commit` | An event is dispatched inside a `DB::transaction` before the commit — the listener may act on uncommitted data |
| `missing_tenant_scope` | A model query runs without a tenant constraint in a multi-tenant context — data leakage risk |

---

## Key advantages

**No false positives from ambiguity**
Detectors reason from the graph structure, not from string patterns in source code. A `missing_authorization` finding only fires when the graph provably has no auth node in the execution path.

**Full evidence chain**
Every finding includes the node IDs involved, the ontology primitives that triggered it, and human-readable evidence descriptions. You know exactly *why* the finding was raised.

**Honest about uncertainty**
When a finding's confidence is lower than HIGH, the `uncertainty` field explains why — unverifiable conditions, missing nodes, inferred symbols. No silent confidence inflation.

**Query-aware ranking**
Pass a natural language query and the explainer reorders findings to surface those most relevant to what you're actually asking about.

---

## Usage

```typescript
import { explain } from "@archmind/explainer"

const findings = explain(graph, "does this endpoint check authorization?")

findings[0].type            // "missing_authorization"
findings[0].severity        // "CRITICAL"
findings[0].confidence      // "HIGH"
findings[0].summary         // "No authorization check found in execution path"
findings[0].evidence        // [{ nodeId, description }]
findings[0].recommendations // ["Add a policy check via $this->authorize()"]
findings[0].uncertainty     // undefined (confidence is HIGH — no caveats)
```

Without a query, findings are returned ranked by severity × confidence. With a query, findings most relevant to the query are surfaced first.

---

## Running tests

```bash
cd packages/explainer
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js
```

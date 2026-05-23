# Phase 3 Prompt Schema

The contract between ArchMind's semantic infrastructure and the LLM reasoning layer.

---

## Design Principles

**LLM is narrator, not source of truth.**
The graph, findings, and ontology are ground truth. The LLM receives curated compressed semantics and translates them into human-readable explanations.

**Ontology-conditioned prompting.**
The prompt does NOT send raw source files. It sends:
- Compressed execution path (typed nodes + edges)
- Ranked findings with provenance
- Confidence + uncertainty signals
- User query context

This eliminates hallucination of architecture and prevents the LLM from inventing relationships not in the graph.

---

## Prompt Structure

```
[SYSTEM]
[USER QUERY]
[EXECUTION PATH]
[SEMANTIC FINDINGS]
[UNCERTAINTY]
[OUTPUT INSTRUCTIONS]
```

### 1. System Block

Sets the LLM persona and constraints. Static per deployment.

```text
You are a semantic code reasoning engine. You explain execution flow and
security findings based ONLY on the structured context provided below.
Do NOT infer relationships not explicitly listed. Do NOT reference source
code not shown. If uncertain, say so.
```

### 2. User Query Block

The original question, verbatim.

```text
User question:
"Why is permission checked twice for the same user and task?"
```

### 3. Execution Path Block

Serialized subgraph: nodes then edges. Token-efficient — no file content, only symbols and types.

```text
Execution path: PUT /tasks/{task}

Nodes:
  [authentication_gate]  auth:sanctum
  [middleware]           ResolveTenant::handle           → injects app('tenant')
  [authorization_check]  CheckPermission::handle(task.update)
  [controller_action]    TaskController::update
  [form_request]         UpdateTaskRequest::authorize
  [policy]               TaskPolicy::update
  [service_call]         PermissionService::hasPermission(TASK_UPDATE)  ← called by CheckPermission
  [service_call]         PermissionService::hasPermission(TASK_UPDATE)  ← called by TaskPolicy

Edges:
  sanctum → ResolveTenant      [next_middleware]
  ResolveTenant → CheckPermission  [next_middleware]
  CheckPermission → TaskController  [next_middleware]
  TaskController → UpdateTaskRequest  [form_request]
  TaskController → TaskPolicy  [policy_check]  via: $this->authorize('update', $task)
  CheckPermission → PermissionService  [calls]
  TaskPolicy → PermissionService  [calls]
```

**Serialization rules:**
- Node format: `  [type]  Symbol  [→ annotation if relevant]`
- Edge format: `  from → to  [relation]  [via: if present]`
- Omit nodes with `relevance: LOW` when token budget is tight
- Collapse `relevance: MEDIUM` nodes to single line with `[compressible]` tag
- Always include `relevance: HIGH` nodes in full

### 4. Semantic Findings Block

Ranked findings from the detector pipeline. One paragraph per finding.

```text
Semantic findings (ranked by severity):

[1] DUPLICATE_AUTHORIZATION — CRITICAL — confidence: HIGH
    CheckPermission::handle checks TASK_UPDATE via PermissionService::hasPermission.
    TaskPolicy::update also checks TASK_UPDATE via the same PermissionService::hasPermission.
    Both checks evaluate the same user/tenant/permission triple on each request.
    Supporting nodes: check_permission, task_policy_update, permission_service_1, permission_service_2
    Supporting edges: check_permission→permission_service_1 [calls], task_policy_update→permission_service_2 [calls]

[2] PRIVILEGE_HIERARCHY — MEDIUM — confidence: MEDIUM
    No elevated permission separation found. Both checks use the same TASK_UPDATE permission level.
```

**Serialization rules:**
- Rank: CRITICAL first, then HIGH, then MEDIUM, then LOW
- Include all CRITICAL and HIGH findings
- Include MEDIUM findings when `token_budget` allows
- Omit LOW findings by default
- Include `supporting_nodes` and `supporting_edges` verbatim from finding provenance

### 5. Uncertainty Block

Only emitted when findings have non-empty `uncertainty` array.

```text
Uncertainty notes:
- The semantic equivalence of tenant->id (middleware) and task->tenant_id (policy)
  is inferred structurally. A runtime divergence is possible if task belongs to
  a different tenant than the active session (confidence: HIGH that they match for
  valid tasks, but the graph cannot prove this without execution traces).
```

### 6. Output Instructions Block

Tells the LLM what JSON shape to produce.

```text
Respond with a JSON object matching this schema exactly:

{
  "finding_type": "<primary finding type, e.g. duplicate_authorization>",
  "severity": "<CRITICAL | HIGH | MEDIUM | LOW>",
  "confidence": "<HIGH | MEDIUM | LOW>",
  "explanation": "<markdown string — 2-4 paragraphs, developer-audience>",
  "key_nodes": ["<symbol>", ...],
  "recommendations": ["<actionable fix>", ...],
  "uncertainty": "<null or one sentence if uncertain>"
}

Rules for explanation field:
- Write for a senior developer reading a PR review
- First paragraph: what the finding is and where it occurs
- Second paragraph: why it matters (security / correctness / performance)
- Third paragraph (optional): when it is acceptable (false positive conditions)
- Do NOT include file paths not shown in context
- Do NOT reference implementation details not in the provided nodes/edges
```

---

## Output JSON Schema

```typescript
interface LLMResponse {
  finding_type: string          // matches FINDING_TYPES constant
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
  confidence: "HIGH" | "MEDIUM" | "LOW"
  explanation: string           // markdown, 2-4 paragraphs
  key_nodes: string[]           // symbols from the execution path
  recommendations: string[]     // actionable fixes, 1-5 items
  uncertainty: string | null    // null if confidence is HIGH and no caveats
}
```

---

## Token Budget

| Section | Typical tokens | Max tokens |
|---|---|---|
| System block | 80 | 80 |
| User query | 20 | 100 |
| Execution path | 150–400 | 600 |
| Semantic findings | 100–300 | 500 |
| Uncertainty | 0–80 | 120 |
| Output instructions | 120 | 120 |
| **Total input** | **470–1000** | **1520** |
| **LLM output** | **200–500** | **800** |

**Compression strategy:**
1. Only include nodes relevant to the query focus (auth / validation / transaction / isolation)
2. Compress MEDIUM nodes: symbol only, no annotation
3. Omit LOW nodes entirely
4. Collapse duplicate service_call symbols into one line with `(×N calls)` suffix

---

## Concrete Example

### Input: AUTH-001 query

```
[SYSTEM]
You are a semantic code reasoning engine. You explain execution flow and
security findings based ONLY on the structured context provided below.
Do NOT infer relationships not explicitly listed. Do NOT reference source
code not shown. If uncertain, say so.

[USER QUESTION]
"Why is permission checked twice for the same user and task?"

[EXECUTION PATH]
Execution path: PUT /tasks/{task}

Nodes:
  [authorization_check]  CheckPermission::handle(task.update)
  [policy]               TaskPolicy::update
  [service_call]         PermissionService::hasPermission(TASK_UPDATE)  ← called by CheckPermission
  [service_call]         PermissionService::hasPermission(TASK_UPDATE)  ← called by TaskPolicy

Edges:
  CheckPermission → TaskController  [next_middleware]
  TaskController → TaskPolicy  [policy_check]  via: $this->authorize('update', $task)
  CheckPermission → PermissionService  [calls]
  TaskPolicy → PermissionService  [calls]

[SEMANTIC FINDINGS]
[1] DUPLICATE_AUTHORIZATION — CRITICAL — confidence: HIGH
    CheckPermission::handle checks TASK_UPDATE via PermissionService::hasPermission.
    TaskPolicy::update also checks TASK_UPDATE via the same PermissionService::hasPermission.
    Both checks evaluate the same user/tenant/permission triple on each request.
    Supporting nodes: check_permission, task_policy_update
    Supporting edges: check_permission→permission_service_1 [calls], task_policy_update→permission_service_2 [calls]

[UNCERTAINTY]
- Semantic equivalence of tenant->id (middleware) vs task->tenant_id (policy) is
  structurally inferred. May differ if task belongs to a different tenant session.

[OUTPUT]
Respond with JSON matching the schema: { finding_type, severity, confidence, explanation, key_nodes, recommendations, uncertainty }
```

### Expected Output

```json
{
  "finding_type": "duplicate_authorization",
  "severity": "CRITICAL",
  "confidence": "HIGH",
  "explanation": "The route `PUT /tasks/{task}` runs two independent permission checks for the same operation. `CheckPermission::handle` runs as middleware and calls `PermissionService::hasPermission(TASK_UPDATE)` before the request reaches the controller. Then `TaskPolicy::update` — invoked via `$this->authorize('update', $task)` in the controller — calls the same `PermissionService::hasPermission(TASK_UPDATE)` a second time.\n\nBoth checks evaluate the same user, tenant, and permission constant (`TASK_UPDATE`) on every request. This means every `PUT /tasks/{task}` call performs at least two database or cache lookups for an answer that is identical. Beyond the performance cost, it creates an implicit contract: if one check is updated (e.g. to add a new condition) but the other is not, authorization behavior silently diverges.\n\nThis is acceptable only if the two checks intentionally enforce different scopes — for example, middleware enforcing a coarse role gate while the policy enforces a fine-grained ownership check. That pattern is not present here: both call the same service with the same argument.",
  "key_nodes": ["CheckPermission::handle", "TaskPolicy::update", "PermissionService::hasPermission"],
  "recommendations": [
    "Remove the `CheckPermission` middleware from this route and rely solely on the policy check via `$this->authorize('update', $task)`.",
    "If the middleware gate serves a different purpose (rate-limiting, audit logging), rename it to reflect that purpose and remove the permission check from it.",
    "Add a comment in the route definition if both checks are intentionally retained, explaining the invariant each enforces."
  ],
  "uncertainty": "The semantic equivalence of tenant->id (checked in middleware) and task->tenant_id (checked in policy) is inferred structurally and may not hold if a task can be reassigned across tenants."
}
```

---

## Validator Contract

The orchestrator validates LLM output before returning to the caller:

1. **Schema check**: response is valid JSON matching `LLMResponse`
2. **Grounding check**: every `key_node` symbol appears in the execution path sent to the LLM
3. **Finding type check**: `finding_type` matches a known `FINDING_TYPES` constant
4. **Severity consistency**: `severity` matches the primary finding's severity from the detector

If validation fails: retry once with error feedback appended to the prompt. If retry fails: return the raw detector output without LLM explanation, flagged as `explanation_failed: true`.

---

## Multi-Finding Handling

When multiple findings exist, the prompt includes all of them ranked. The LLM output addresses the **primary** (highest-severity) finding only. The orchestrator calls the LLM once per CRITICAL finding, then aggregates into a `MultiExplanation` envelope:

```typescript
interface MultiExplanation {
  primary: LLMResponse           // highest-severity finding
  secondary: LLMResponse[]       // remaining findings, ordered by severity
  graph_summary: string          // 1-sentence path summary, LLM-generated
}
```

This keeps per-call token cost bounded while covering all findings.

---

## Packages This Schema Drives

| Package | Responsibility |
|---|---|
| `packages/prompt-builder` | Serialize graph + findings → prompt string per this schema |
| `packages/llm-client` | Send prompt, receive JSON, parse `LLMResponse` |
| `packages/orchestrator` | Query → retrieval → detector → prompt-builder → llm-client → validator |

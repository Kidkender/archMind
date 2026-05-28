# ArchMind Findings: Evaluation Philosophy & Semantics

## What a "Finding" means

A finding is a structured claim ArchMind makes about an execution path. It has three properties:

| Property      | What it means                                              |
|---------------|------------------------------------------------------------|
| **type**      | The category of the problem (e.g. `missing_authorization`) |
| **severity**  | How bad this is if exploited or triggered                  |
| **confidence**| How certain ArchMind is that this finding is real          |

A finding is NOT a definitive verdict. It is a reasoned hypothesis with evidence. The LLM explains; the detector flags; the developer decides.

---

## Evaluation layers

ArchMind uses three distinct evaluation layers. They answer different questions and have different noise profiles.

### Layer 1: Retrieval (deterministic)

**Question:** Did we extract the right nodes from the codebase?

**Metric:** `combined_recall = 0.7 * high_recall + 0.3 * medium_recall`

**Noise:** Near-zero. Retrieval is a pure function of AST parsing + graph traversal. Same input → same output.

**CI guard:** `retrieval-regression.test.ts` — runs on every commit, fails fast if recall drops below locked thresholds.

### Layer 2: Reasoning (probabilistic)

**Question:** Did the LLM produce a useful answer given the retrieved graph?

**Metric:** Weighted score across `finding_type`, `severity`, `key_nodes`, `explanation`, `recommendations`.

**Noise:** LLM temperature variance — ±0.1–0.3 depending on trace. **Never interpret a single-run score as ground truth.**

**Recommended eval:** Run N=5, report `mean ± stddev`. A result is meaningful when `stddev < delta/2`.

### Layer 3: Utility (human judgment — Phase 8+)

**Question:** Does a real developer find ArchMind's output useful?

**Metric:** Task completion speed, trust rating, "would you act on this?" surveys.

**Status:** Not yet implemented. Phase 7 stabilizes Layers 1–2 as prerequisite.

---

## Detector taxonomy

Detectors fall into two categories. **Do not mix them.**

### Structural detectors (deterministic)

These detect verifiable facts about the codebase graph. No LLM involved. Safe to run in CI.

| Detector                  | What it checks                                              |
|---------------------------|-------------------------------------------------------------|
| `missing_policy`          | Policy class referenced but file doesn't exist on disk      |
| `missing_authorization`   | Mutation route has auth gate but no policy/role check       |
| `duplicate_authorization` | Same permission checked at both middleware and policy layer |
| `double_permission_check` | Two permission nodes for the same ability in the same route |
| `event_before_commit`     | Event dispatched inside transaction without `ShouldHandleEventsAfterCommit` |
| `missing_tenant_scope`    | Model query without tenant isolation in a multi-tenant context |

These findings are HIGH confidence by default. If a structural fact is wrong (e.g. the policy file exists but wasn't found), it's a parser bug, not a reasoning failure.

### Semantic detectors (probabilistic)

These detect patterns that require interpretation. They run through the retrieval + LLM layer.

| Detector                       | Why it's semantic                                          |
|--------------------------------|------------------------------------------------------------|
| `delegated_validation`         | "Sufficient" authorization is a judgment call              |
| `hidden_runtime_dependency`    | Whether a runtime dependency is "hidden" depends on intent |
| `privilege_hierarchy_present`  | Whether hierarchy is a risk depends on business context    |

These findings may have MEDIUM confidence. The LLM's explanation is load-bearing — without it, the finding is just a graph pattern.

---

## Benchmark integrity rules

1. **Never modify golden traces to fix a score.** A failing trace reveals a real limitation. Document it instead.

2. **Known limitations are acceptable.** If ArchMind can't surface a missing policy class because the graph correctly omits it (context ceiling), accept this and annotate the golden answer with `known_limitation: true`.

3. **Multi-run before claiming superiority.** A single run where ArchMind beats NaiveRAG by +0.1 is not a valid claim. Run N=5 and report mean ± stddev. Only claim superiority if `mean_delta > 2 * avg_stddev`.

4. **Snapshot diffs are mandatory for retrieval changes.** Before merging any change to `laravel-parser` or `retrieval-engine`, run `manage-baseline.ts --verify`. If baseline drifts, run `--update` and include the diff in the PR description.

5. **Retrieval and reasoning regressions are different bugs.** A drop in retrieval recall is a parser/graph bug. A drop in LLM score is usually an evaluation noise issue. Diagnose separately.

---

## Confidence expectations

| Confidence | When to use                                                                |
|------------|----------------------------------------------------------------------------|
| HIGH       | Structural facts — class missing, file not found, edge explicitly present  |
| MEDIUM     | Semantic patterns — depends on project context, may have false positives   |
| LOW        | Inferred behavior — runtime or probabilistic, best-effort                  |

If a finding has `confidence: LOW`, the LLM's `uncertainty` field should explain why.

---

## Snapshot update workflow

When retrieval behavior intentionally changes (parser improvement, new node type added):

```bash
# From packages/retrieval/
node --loader ts-node/esm src/scripts/manage-baseline.ts --update --label retrieval-main
```

Then commit the updated `benchmarks/baselines/retrieval-main.json`.

When verifying in CI:

```bash
node --loader ts-node/esm src/scripts/manage-baseline.ts --verify --label retrieval-main
```

Exit code 0 = no drift. Exit code 1 = drift detected, manual review required.

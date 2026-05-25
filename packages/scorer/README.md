# @archmind/scorer

**Measures how well ArchMind's retrieval and reasoning actually perform — against ground-truth data, not assumptions.**

---

## Why objective scoring matters

It's easy to claim a retrieval system is accurate. It's harder to prove it. `@archmind/scorer` makes quality measurable and regression-proof by providing ground-truth golden traces and the functions to score any result against them.

Every benchmark in the system uses the scorer. When a change improves recall on one trace but breaks another, the numbers say so immediately.

---

## What it scores

### Retrieval quality
Given a ground-truth golden trace (which nodes *should* be retrieved) and an actual `RetrievalResult` (which nodes *were* retrieved), the scorer computes:

- **High recall** — fraction of HIGH-relevance nodes present in the result
- **Medium recall** — fraction of MEDIUM-relevance nodes present
- **Combined recall** — `0.7 × high_recall + 0.3 × medium_recall`

HIGH-relevance nodes are weighted more because they represent the semantically critical parts of the execution path — the ones that cause real bugs when missed.

### Answer quality
Scores an LLM-generated `LLMResponse` against a `GoldenAnswer`. Checks that the finding type, severity, key nodes, key phrases, and recommendations align with what a correct answer should contain.

### Conversation quality
Scores a multi-turn conversation against a `GoldenConversation`. Evaluates each turn for per-turn correctness and the overall ability to maintain context and reason about follow-up questions.

---

## Ground-truth format

Golden traces are YAML files in `research/golden-traces/laravel/`. Each one defines the ground truth for a specific entrypoint:

```yaml
id: LARAVEL-AUTH-001
entrypoint: "PUT /tasks/{task}"
framework: laravel

nodes:
  - id: policy_TaskPolicy_update
    type: policy
    symbol: TaskPolicy::update
    retrieval:
      relevance: HIGH       # must be retrieved
      compressible: false

  - id: ctrl_TaskController_update
    type: controller_action
    symbol: TaskController::update
    retrieval:
      relevance: MEDIUM
      compressible: true
```

Node matching uses symbol substring matching plus semantic type equivalence — not exact ID comparison. This makes the scorer resilient to minor changes in how nodes are named.

---

## Adversarial cases

`research/adversarial-cases/` documents cases that the parser is *expected* to handle imperfectly — dynamic middleware, runtime-generated routes, etc. These have `expected_failure: true` annotations. They are not bugs to fix; they document the known boundaries of static analysis.

---

## Usage

```typescript
import { loadGoldenTrace, scoreRetrieval } from "@archmind/scorer"

const golden = loadGoldenTrace("research/golden-traces/laravel/LARAVEL-AUTH-001.yaml")
const result = retrieve({ entrypoint: golden.entrypoint }, graphs)
const score  = scoreRetrieval(golden, result)

score.combined_recall   // e.g. 1.00
score.high_recall       // e.g. 1.00
score.medium_recall     // e.g. 1.00
```

---

## Running tests

```bash
cd packages/scorer
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js
```

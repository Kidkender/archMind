# @archmind/orchestrator

**The end-to-end reasoning loop — takes a plain language question and returns a validated, structured explanation of an HTTP endpoint.**

---

## What it does

`@archmind/orchestrator` is the top-level coordinator. It wires together every other package in the pipeline and exposes a clean interface: give it a question, get back a validated answer.

```
question + entrypoint
      ↓
  retrieve minimal subgraph   (@archmind/retrieval)
      ↓
  detect semantic findings    (@archmind/explainer)
      ↓
  compile structured prompt   (@archmind/prompt-builder)
      ↓
  call the LLM                (@archmind/llm-client)
      ↓
  validate the response
      ↓
  return structured result
```

It also manages conversation history across turns, so follow-up questions maintain context without re-parsing anything.

---

## Key benefits

**Single entry point**
You don't need to know about retrieval focus, prompt modes, or response schemas to use ArchMind. The `Orchestrator` handles all of that.

**Conversation-aware**
Multi-turn sessions work naturally. Ask a follow-up and the orchestrator carries forward the prior context, detects contradictions between turns, and builds on previous reasoning.

**Fail-safe response handling**
If the LLM returns a malformed response, `explanation_failed` is set to `true` and the result is still returned safely — the system doesn't crash, and you know exactly what went wrong.

**Benchmarking included**
`runAnswerBenchmark()` and `runConversationBenchmark()` let you measure LLM quality against ground-truth golden traces. Useful for comparing models, prompts, and modes objectively.

---

## Usage

```typescript
import { Orchestrator } from "@archmind/orchestrator"
import { ClaudeLLMClient } from "@archmind/llm-client"

const orchestrator = new Orchestrator({
  graphs:    parsedGraphs,
  llmClient: new ClaudeLLMClient(),
})

// Ask a question
const result = await orchestrator.query(
  "does PUT /tasks/{task} check that the user owns the task before updating it?",
  { mode: "review" }
)

console.log(result.response.explanation)
console.log(result.response.recommendations)
console.log(result.findings_count)    // how many findings were detected
console.log(result.token_estimate)    // tokens the retrieval used

// Follow-up in the same conversation
const followUp = await orchestrator.query(
  "what would happen if the policy method returned true unconditionally?",
  { mode: "teach", conversationContext: result.conversation }
)
```

---

## Query modes

| Mode | Reasoning style |
|---|---|
| `review` | Security-focused reviewer. Returns findings, evidence, and fixes. |
| `teach` | Patient explainer. Walks through the execution path step-by-step. |
| `debug` | Terse root-cause analyst. Skips background, jumps straight to the problem. |

---

## Benchmarking

```typescript
import { runAnswerBenchmark } from "@archmind/orchestrator"

const snapshot = await runAnswerBenchmark({
  goldenDir:  "research/golden-answers/laravel",
  graphs:     parsedGraphs,
  llmClient:  new ClaudeLLMClient({ model: "claude-sonnet-4-6" }),
  label:      "sonnet-4-6-baseline",
})

snapshot.summary.avg_score      // 0.0 – 1.0
snapshot.summary.total_traces
```

Conversation benchmarks work the same way — they replay multi-turn golden conversations and score each turn for coherence, correctness, and follow-up reasoning quality.

---

## Running tests

```bash
cd packages/orchestrator
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js
```

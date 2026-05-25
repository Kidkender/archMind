# @archmind/prompt-builder

**Compiles execution graphs and findings into structured LLM prompts — with mode-aware reasoning and conversation history support.**

---

## Why a dedicated prompt builder?

A prompt is not just a string. For ArchMind to get consistent, structured responses from an LLM, the prompt needs to:

- Present the execution graph in a format the LLM can reason about
- Include findings with enough context to explain but not overwhelm
- Enforce a specific output schema via instructions
- Adapt the reasoning style to what the user is trying to do
- Carry forward relevant context from prior conversation turns
- Flag when new context contradicts what was said before

Doing this ad-hoc in the orchestrator would be fragile and untestable. `@archmind/prompt-builder` makes it a first-class, independently testable stage in the pipeline.

---

## Key features

**Mode-aware prompts**
The same graph and findings can be presented to the LLM in three different ways depending on what you're trying to accomplish:

| Mode | Behavior | Best for |
|---|---|---|
| `review` | Concise security reviewer — findings-focused, terse | PR review, security audit |
| `teach` | Patient senior engineer — step-by-step, uses analogies | Onboarding, explaining unfamiliar code |
| `debug` | Terse incident responder — root cause only, minimal fix | Production incidents, debugging |

The system prompt, framing, and output instructions all change with the mode. The underlying graph and findings stay the same.

**Structured output enforcement**
Each mode includes specific `output_instructions` that tell the LLM exactly what JSON schema to return. This is what allows `@archmind/llm-client` to validate the response reliably.

**Conversation continuity**
Pass previous `ConversationTurn[]` and the prompt builder weaves them into the context. The LLM can reference what was said before and build on prior reasoning.

**Contradiction detection**
`detectContradictions()` compares the current graph against prior conversation turns. If a new graph context contradicts a claim made earlier, the discrepancy is injected into the prompt so the LLM can acknowledge and correct it — not silently repeat a stale answer.

---

## Usage

```typescript
import { buildPrompt } from "@archmind/prompt-builder"

const prompt = buildPrompt({
  query:    "does this endpoint validate the request body?",
  graph:    graph,
  findings: findings,
  mode:     "teach",         // optional, defaults to "review"
  history:  priorTurns,      // optional, for multi-turn sessions
})

// Pass to any LLMClient:
const result = await llmClient.call(prompt)
```

---

## Running tests

```bash
cd packages/prompt-builder
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js
```

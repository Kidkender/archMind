# @archmind/llm-client

**A thin, swappable LLM abstraction that enforces structured output — so the rest of the system never has to worry about which model is running.**

---

## Why this package exists

LLM providers change. Models get deprecated. During development you don't want to burn API credits on every test run. And you always want to know whether the LLM actually returned what you asked for, or whether it hallucinated a different JSON structure.

`@archmind/llm-client` solves all three problems with a single interface, three implementations, and built-in response validation.

---

## Key benefits

**Provider-agnostic**
The `Orchestrator` and benchmarks only know about `LLMClient`. Switching from Claude to OpenAI — or to a local model — requires changing one line, not refactoring the reasoning pipeline.

**Structured output enforcement**
Every LLM response is validated against a fixed schema before it reaches the rest of the system. If the model returns malformed JSON or a missing field, the call fails cleanly with a `ValidationError[]` — not a runtime crash downstream.

**Deterministic testing**
`MockLLMClient` returns a hardcoded response on every call. Benchmarks and unit tests get consistent, reproducible results without network calls or cost.

---

## The response contract

All clients return responses that conform to this schema:

```typescript
{
  finding_type:    string    // maps to a Finding.type from @archmind/explainer
  severity:        "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
  confidence:      "HIGH" | "MEDIUM" | "LOW"
  explanation:     string    // markdown, developer-audience, 2–4 paragraphs
  key_nodes:       string[]  // symbols of the most important nodes in the explanation
  recommendations: string[]  // actionable fixes
  uncertainty:     string | null
}
```

The LLM is instructed to produce this schema via the prompt's `output_instructions` field (compiled by `@archmind/prompt-builder`). `validateLLMResponse()` verifies the output after the call.

---

## Clients

**`ClaudeLLMClient`** — Anthropic API. Requires `ANTHROPIC_API_KEY`.  
**`OpenAILLMClient`** — OpenAI API. Requires `OPENAI_API_KEY`.  
**`MockLLMClient`** — Hardcoded response. No network, no cost. Used in all tests.

```typescript
import { ClaudeLLMClient, MockLLMClient } from "@archmind/llm-client"

// Production
const client = new ClaudeLLMClient({ model: "claude-sonnet-4-6" })

// Tests / benchmarks
const client = new MockLLMClient({
  finding_type: "missing_authorization",
  severity: "HIGH",
  confidence: "HIGH",
  explanation: "No auth check found.",
  key_nodes: [],
  recommendations: ["Add $this->authorize()"],
  uncertainty: null,
})
```

---

## Running tests

```bash
cd packages/llm-client
node --experimental-vm-modules ../../node_modules/jest/bin/jest.js
```

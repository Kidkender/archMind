import type { IntermediateExecutionGraph } from "@archmind/protocol"
import { explain } from "../index.js"
import { selectEvidenceByIntent, buildExecutionPath } from "./selector.js"
import { extractFacts } from "./facts.js"
import type { EvidencePackage } from "./types.js"

export function buildEvidencePackage(
  question: string,
  graph: IntermediateExecutionGraph
): EvidencePackage {
  // 1. Extract intent from question — drives everything downstream
  const intent = detectIntent(question)

  // 2. Build execution path
  const executionPath = buildExecutionPath(graph)

  // 3. Intent-first evidence selection (finding is secondary enrichment)
  const findings = explain(graph, question)
  const top = findings[0]
  const evidence = selectEvidenceByIntent(graph, intent, top)

  // 4. Extract structured facts per intent — replaces supporting_text
  const facts = extractFacts(graph, intent)

  // 5. Attach finding as metadata (not driver)
  return {
    question,
    intent,
    facts,
    execution_path: executionPath,
    evidence,
    finding:    top?.type      ?? "none",
    severity:   top?.severity  ?? "INFO",
    confidence: top?.confidence ?? "LOW",
  }
}

// Inline intent classifier — mirrors classify.ts logic without importing it
// to avoid a circular dep chain (builder → index → classify → builder).
const AUTH_RE        = /\b(auth|authoriz|permission|policy|middleware|guard|access|role|privilege|guest|unauthenticated|anonymous|public.endpoint|who.can)/i
const VALIDATION_RE  = /\b(validat|form.?request)/i
const RUNTIME_RE     = /\b(runtime|inject|container)/i
const TRANSACTION_RE = /\b(transaction|commit|rollback|atomic|dispatch.*before|event.*commit)/i
const ISOLATION_RE   = /\b(tenant|isolation|cross.tenant|multi.tenant|scope|unscoped|data.leak)/i

function detectIntent(question: string): EvidencePackage["intent"] {
  if (TRANSACTION_RE.test(question)) return "transaction"
  if (ISOLATION_RE.test(question))   return "isolation"
  if (AUTH_RE.test(question))        return "auth"
  if (VALIDATION_RE.test(question))  return "validation"
  if (RUNTIME_RE.test(question))     return "runtime"
  return "all"
}

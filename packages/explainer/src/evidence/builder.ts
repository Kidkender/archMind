import type { IntermediateExecutionGraph } from "@archmind/protocol"
import { explain } from "../index.js"
import { selectEvidence, buildExecutionPath } from "./selector.js"
import type { EvidencePackage } from "./types.js"

const NO_FINDING_PACKAGE = (question: string): EvidencePackage => ({
  question,
  intent: "all",
  finding: "none",
  severity: "INFO",
  confidence: "LOW",
  execution_path: [],
  evidence: [],
  supporting_text: "No findings detected for this route.",
})

export function buildEvidencePackage(
  question: string,
  graph: IntermediateExecutionGraph
): EvidencePackage {
  const findings = explain(graph, question)
  if (findings.length === 0) return NO_FINDING_PACKAGE(question)

  const top = findings[0]
  const intent = detectIntent(question)
  const executionPath = buildExecutionPath(graph)
  const evidence = selectEvidence(top, graph, intent)

  return {
    question,
    intent,
    finding: top.type,
    severity: top.severity,
    confidence: top.confidence,
    execution_path: executionPath,
    evidence,
    supporting_text: top.summary,
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

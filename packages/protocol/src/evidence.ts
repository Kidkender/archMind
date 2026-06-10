// Evidence Package — structured context for LLM reasoning.
// ArchMind selects the minimal relevant subgraph for a question
// and packages it as a typed artifact instead of dumping raw nodes.

export type QueryFocusType = "auth" | "validation" | "runtime" | "transaction" | "isolation" | "all"

export interface EvidenceItem {
  nodeId: string
  symbol: string
  type: string     // ir:auth_gate, ir:business_handler, ...
  role: string     // "middleware", "controller", "policy", "resource", ...
  detail?: string  // mechanism, annotation text, or relevant metadata
}

export interface EvidencePackage {
  question: string
  intent: QueryFocusType
  // Top finding driving the evidence selection
  finding: string        // e.g. "resource_unprotected"
  severity: string       // "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
  confidence: string     // "HIGH" | "MEDIUM" | "LOW"
  // Ordered node IDs from entrypoint to handler (execution flow)
  execution_path: string[]
  // Nodes directly relevant to the finding + question
  evidence: EvidenceItem[]
  // 1-2 sentence human-readable summary for LLM prompt context
  supporting_text: string
}

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

// Structured fact extracted from the graph for a given intent.
// Preserves the distinction between "absent fact" and "present fact"
// without lossy NL summaries.
export interface FactEntry {
  type: string                        // "auth_middleware" | "ownership_check" | "txn_boundary" | ...
  present: boolean
  value?: string                      // concrete value e.g. "auth:sanctum", "permission:orders"
  relevance: "high" | "medium" | "low"
}

export interface EvidencePackage {
  question: string
  intent: QueryFocusType
  // Structured facts extracted per intent — replaces supporting_text
  facts: FactEntry[]
  // Ordered node IDs from entrypoint to handler (execution flow)
  execution_path: string[]
  // Nodes directly relevant to the intent + question
  evidence: EvidenceItem[]
  // Top detected finding — metadata only, no longer drives evidence selection
  finding: string        // e.g. "resource_unprotected"
  severity: string       // "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
  confidence: string     // "HIGH" | "MEDIUM" | "LOW"
  /** @deprecated Use facts[] instead — retained for backward compat */
  supporting_text?: string
}

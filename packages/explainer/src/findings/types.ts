export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
export type Confidence = "HIGH" | "MEDIUM" | "LOW"

export type UncertaintyReason =
  | { kind: "unverifiable_condition"; description: string }
  | { kind: "low_fact_confidence"; nodeId: string; description: string }
  | { kind: "missing_node"; nodeId: string; description: string }
  | { kind: "inferred_symbol"; nodeId: string; description: string }
  | { kind: "no_consumers_detected"; description: string }

export interface ReasoningStep {
  type: string
  [key: string]: unknown
}

export interface Evidence {
  nodeId: string
  description: string
  detail?: string
}

export interface Provenance {
  detector: string
  ontology_primitives: string[]
  supporting_nodes: string[]
  supporting_edges: string[]
}

export interface Finding {
  id: string
  type: string                   // string not literal union — new detectors don't touch this file
  severity: Severity
  confidence: Confidence
  provenance: Provenance
  summary: string
  reasoning: ReasoningStep[]
  evidence: Evidence[]
  uncertainty?: UncertaintyReason[]
  recommendations?: string[]
}

export const FINDING_TYPES = {
  DUPLICATE_AUTHORIZATION: "duplicate_authorization",
  MISSING_AUTHORIZATION: "missing_authorization",
  DELEGATED_VALIDATION: "delegated_validation",
  HIDDEN_RUNTIME_DEPENDENCY: "hidden_runtime_dependency",
  PRIVILEGE_HIERARCHY_PRESENT: "privilege_hierarchy_present",
} as const

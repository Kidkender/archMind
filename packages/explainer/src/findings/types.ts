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
  MISSING_POLICY: "missing_policy",
  DELEGATED_VALIDATION: "delegated_validation",
  HIDDEN_RUNTIME_DEPENDENCY: "hidden_runtime_dependency",
  PRIVILEGE_HIERARCHY_PRESENT: "privilege_hierarchy_present",
  EVENT_BEFORE_COMMIT: "event_before_commit",
  MISSING_TENANT_SCOPE: "missing_tenant_scope",
  DOUBLE_PERMISSION_CHECK: "double_permission_check",
  RUNTIME_CONSUMER_TRACE: "runtime_consumer_trace",
  RESOURCE_MISMATCH:      "resource_mismatch",
  RESOURCE_UNPROTECTED:   "resource_unprotected",
} as const

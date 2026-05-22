export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
export type Confidence = "HIGH" | "MEDIUM" | "LOW"

export interface ReasoningStep {
  type: string
  [key: string]: unknown
}

export interface Evidence {
  nodeId: string
  description: string
  detail?: string
}

export interface Finding {
  id: string
  type: string                   // string not literal union — new detectors don't touch this file
  severity: Severity
  confidence: Confidence
  primitives: string[]
  involvedNodes: string[]
  summary: string
  reasoning: ReasoningStep[]
  evidence: Evidence[]
  uncertainty?: string[]
  recommendations?: string[]
}

export const FINDING_TYPES = {
  DUPLICATE_AUTHORIZATION: "duplicate_authorization",
  MISSING_AUTHORIZATION: "missing_authorization",
  DELEGATED_VALIDATION: "delegated_validation",
  HIDDEN_RUNTIME_DEPENDENCY: "hidden_runtime_dependency",
} as const

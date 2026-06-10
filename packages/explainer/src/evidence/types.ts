import type { QueryFocus } from "../query/types.js"

export type { QueryFocus }

export interface EvidenceItem {
  nodeId: string
  symbol: string
  type: string
  role: string
  detail?: string
}

export interface EvidencePackage {
  question: string
  intent: QueryFocus
  finding: string
  severity: string
  confidence: string
  execution_path: string[]
  evidence: EvidenceItem[]
  supporting_text: string
}

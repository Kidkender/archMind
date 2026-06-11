import type { QueryFocus } from "../query/types.js"

export type { QueryFocus }

export interface EvidenceItem {
  nodeId: string
  symbol: string
  type: string
  role: string
  detail?: string
}

export interface FactEntry {
  type: string
  present: boolean
  value?: string
  relevance: "high" | "medium" | "low"
}

export interface IntentScore {
  intent: QueryFocus
  score: number
}

export interface EvidencePackage {
  question: string
  intent: QueryFocus          // primary (highest score) intent
  intents?: IntentScore[]     // all active intents with scores (multi-intent diagnostic)
  facts: FactEntry[]
  execution_path: string[]
  evidence: EvidenceItem[]
  finding: string
  severity: string
  confidence: string
  /** @deprecated Use facts[] instead */
  supporting_text?: string
}

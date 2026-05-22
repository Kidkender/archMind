import type { Finding, Severity, Confidence } from "../findings/types.js"

const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 5,
  HIGH:     4,
  MEDIUM:   3,
  LOW:      2,
  INFO:     1,
}

const CONFIDENCE_RANK: Record<Confidence, number> = {
  HIGH:   3,
  MEDIUM: 2,
  LOW:    1,
}

export function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const sevDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    if (sevDiff !== 0) return sevDiff

    const confDiff = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]
    if (confDiff !== 0) return confDiff

    const nodeDiff = b.provenance.supporting_nodes.length - a.provenance.supporting_nodes.length
    if (nodeDiff !== 0) return nodeDiff

    const recDiff = (b.recommendations?.length ?? 0) - (a.recommendations?.length ?? 0)
    if (recDiff !== 0) return recDiff

    return a.id.localeCompare(b.id)
  })
}

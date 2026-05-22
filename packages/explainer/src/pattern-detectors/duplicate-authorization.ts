import type { SemanticFact, AuthorizationCheckFact } from "../fact-extraction/types.js"
import type { Finding, ReasoningStep, Evidence } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"

let _counter = 0

function makeId(): string {
  return `${FINDING_TYPES.DUPLICATE_AUTHORIZATION}-${++_counter}`
}

export function detectDuplicateAuthorization(facts: SemanticFact[]): Finding[] {
  const authFacts = facts.filter(
    (f): f is AuthorizationCheckFact => f.kind === "authorization_check"
  )

  // Group by normalized ability; only HIGH/MEDIUM confidence facts are meaningful
  const byAbility = new Map<string, AuthorizationCheckFact[]>()

  for (const fact of authFacts) {
    if (!fact.ability || fact.confidence === "LOW") continue
    const key = fact.ability
    const group = byAbility.get(key) ?? []
    group.push(fact)
    byAbility.set(key, group)
  }

  const findings: Finding[] = []

  for (const [ability, group] of byAbility) {
    const layers = [...new Set(group.map((f) => f.layer))]
    if (layers.length < 2) continue   // need ≥2 different layers to be duplicate

    const reasoning: ReasoningStep[] = group.map((f) => ({
      type: "authorization_check",
      node: f.nodeId,
      symbol: f.symbol,
      permission: f.permission,
      ability,
      layer: f.layer,
      confidence: f.confidence,
    }))

    reasoning.push({
      type: "execution_overlap_detected",
      layers,
      ability,
    })

    const evidence: Evidence[] = group.map((f) => ({
      nodeId: f.nodeId,
      description: `${f.layer} layer checks permission for "${ability}"`,
      detail: f.permission ?? undefined,
    }))

    const uncertainty: string[] = []
    const mediumFacts = group.filter((f) => f.confidence === "MEDIUM")
    if (mediumFacts.length > 0) {
      uncertainty.push(
        `${mediumFacts.length} authorization check(s) inferred semantically (no explicit permission arg)`
      )
    }

    findings.push({
      id: makeId(),
      type: FINDING_TYPES.DUPLICATE_AUTHORIZATION,
      severity: "LOW",
      confidence: group.every((f) => f.confidence === "HIGH") ? "HIGH" : "MEDIUM",
      primitives: ["AuthorizationCheck", "ExecutionOverlap"],
      involvedNodes: group.map((f) => f.nodeId),
      summary: `Permission "${ability}" is checked in ${layers.length} layers: ${layers.join(", ")}`,
      reasoning,
      evidence,
      ...(uncertainty.length > 0 ? { uncertainty } : {}),
      recommendations: [
        `Consider consolidating "${ability}" authorization to a single layer (typically policy or middleware)`,
      ],
    })
  }

  return findings
}

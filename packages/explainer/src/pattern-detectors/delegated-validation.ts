import type { SemanticFact, ValidationGateFact } from "../fact-extraction/types.js"
import type { Finding, ReasoningStep, Evidence } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"

let _counter = 0

function makeId(): string {
  return `${FINDING_TYPES.DELEGATED_VALIDATION}-${++_counter}`
}

export function detectDelegatedValidation(
  facts: SemanticFact[],
  authNodeIds: string[]
): Finding[] {
  const gateFacts = facts.filter(
    (f): f is ValidationGateFact =>
      f.kind === "validation_gate" && f.delegatesAuthorization
  )

  if (gateFacts.length === 0) return []

  const findings: Finding[] = []

  for (const gate of gateFacts) {
    const reasoning: ReasoningStep[] = [
      {
        type: "form_request_passthrough",
        node: gate.nodeId,
        symbol: gate.symbol,
        delegatesAuthorization: true,
      },
    ]

    if (authNodeIds.length > 0) {
      reasoning.push({
        type: "real_auth_layers_present",
        nodes: authNodeIds,
        count: authNodeIds.length,
      })
      reasoning.push({
        type: "delegation_confirmed",
        description: "FormRequest::authorize() intentionally defers to upstream auth layers",
      })
    } else {
      reasoning.push({
        type: "delegation_unverified",
        description: "No upstream auth layers detected — delegation may be unintentional",
      })
    }

    const evidence: Evidence[] = [
      {
        nodeId: gate.nodeId,
        description: `${gate.symbol} returns true — performs no authorization check`,
      },
      ...authNodeIds.map((id) => ({
        nodeId: id,
        description: "Real authorization layer present in this request path",
      })),
    ]

    const uncertainty: string[] = []
    if (gate.confidence === "MEDIUM") {
      uncertainty.push("Authorization delegation inferred from graph structure, not explicit annotation")
    }

    const severity = authNodeIds.length > 0 ? "INFO" as const : "MEDIUM" as const
    const confidence = gate.confidence

    findings.push({
      id: makeId(),
      type: FINDING_TYPES.DELEGATED_VALIDATION,
      severity,
      confidence,
      primitives: ["DelegatedAuthorization"],
      involvedNodes: [gate.nodeId, ...authNodeIds],
      summary: authNodeIds.length > 0
        ? `${gate.symbol} delegates authorization to ${authNodeIds.length} upstream layer(s)`
        : `${gate.symbol} returns true with no upstream auth layers detected`,
      reasoning,
      evidence,
      ...(uncertainty.length > 0 ? { uncertainty } : {}),
      recommendations: authNodeIds.length === 0
        ? [`Verify that authorization for this endpoint is enforced elsewhere`]
        : undefined,
    })
  }

  return findings
}

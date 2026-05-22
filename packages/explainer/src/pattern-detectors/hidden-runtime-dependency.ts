import type { SemanticFact, RuntimeInjectionFact } from "../fact-extraction/types.js"
import type { IntermediateExecutionGraph } from "@archmind/protocol"
import type { Finding, ReasoningStep, Evidence } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { extractRuntimeConsumers } from "../fact-extraction/runtime.js"

let _counter = 0

function makeId(): string {
  return `${FINDING_TYPES.HIDDEN_RUNTIME_DEPENDENCY}-${++_counter}`
}

export function detectHiddenRuntimeDependency(
  facts: SemanticFact[],
  graph: IntermediateExecutionGraph
): Finding[] {
  const runtimeFacts = facts.filter(
    (f): f is RuntimeInjectionFact => f.kind === "runtime_injection"
  )

  const findings: Finding[] = []

  for (const fact of runtimeFacts) {
    const consumers = extractRuntimeConsumers(graph, fact.injectedValue)

    const reasoning: ReasoningStep[] = [
      {
        type: "runtime_injection",
        node: fact.nodeId,
        symbol: fact.symbol,
        injectedKey: fact.injectedValue,
        mechanism: fact.sideEffect,
      },
    ]

    for (const consumer of consumers) {
      reasoning.push({
        type: "runtime_consume",
        node: consumer.nodeId,
        symbol: consumer.symbol,
        consumedKey: consumer.consumedKey,
      })
    }

    reasoning.push({
      type: "implicit_contract_detected",
      description: `Injector must execute before all consumers — enforced only by route group placement`,
    })

    const evidence: Evidence[] = [
      {
        nodeId: fact.nodeId,
        description: `Injects "${fact.injectedValue}" into service container`,
        detail: fact.sideEffect,
      },
      ...consumers.map((c) => ({
        nodeId: c.nodeId,
        description: `Consumes "${c.consumedKey}" from service container`,
        detail: `app('${c.consumedKey}')`,
      })),
    ]

    const uncertainty: string[] = []
    if (fact.confidence === "MEDIUM") {
      uncertainty.push("Injected key inferred from symbol — actual key may differ")
    }
    if (consumers.length === 0) {
      uncertainty.push("No consumers detected via static edges — runtime consumers may exist")
    }

    const allNodes = [fact.nodeId, ...consumers.map((c) => c.nodeId)]

    findings.push({
      id: makeId(),
      type: FINDING_TYPES.HIDDEN_RUNTIME_DEPENDENCY,
      severity: "HIGH",
      confidence: fact.confidence,
      primitives: ["RuntimeContract"],
      involvedNodes: allNodes,
      summary: consumers.length > 0
        ? `"${fact.injectedValue}" is injected at runtime and consumed by ${consumers.length} node(s) — implicit contract not enforced by type system`
        : `"${fact.injectedValue}" is injected at runtime — no static consumers detected`,
      reasoning,
      evidence,
      ...(uncertainty.length > 0 ? { uncertainty } : {}),
      recommendations: [
        `Ensure the injector (${fact.nodeId}) is always in the route group middleware stack before any consumer`,
        `Consider constructor injection or service binding to make this dependency explicit`,
      ],
    })
  }

  return findings
}

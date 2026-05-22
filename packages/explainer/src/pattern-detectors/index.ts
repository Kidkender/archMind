import type { SemanticFact, AuthorizationCheckFact } from "../fact-extraction/types.js"
import type { IntermediateExecutionGraph } from "@archmind/protocol"
import type { Finding } from "../findings/types.js"
import { detectDuplicateAuthorization } from "./duplicate-authorization.js"
import { detectDelegatedValidation } from "./delegated-validation.js"
import { detectHiddenRuntimeDependency } from "./hidden-runtime-dependency.js"
import { detectPrivilegeHierarchy } from "./privilege-hierarchy.js"

function getAuthNodeIds(facts: SemanticFact[]): string[] {
  return facts
    .filter((f): f is AuthorizationCheckFact => f.kind === "authorization_check")
    .map((f) => f.nodeId)
}

export function detect(
  facts: SemanticFact[],
  graph: IntermediateExecutionGraph
): Finding[] {
  const authNodeIds = getAuthNodeIds(facts)

  return [
    ...detectDuplicateAuthorization(facts, graph),
    ...detectDelegatedValidation(facts, authNodeIds, graph),
    ...detectHiddenRuntimeDependency(facts, graph),
    ...detectPrivilegeHierarchy(facts, graph),
  ]
}

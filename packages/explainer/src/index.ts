import type { IntermediateExecutionGraph } from "@archmind/protocol"
import type { SemanticFact } from "./fact-extraction/types.js"
import type { Finding } from "./findings/types.js"
import { extractFacts } from "./fact-extraction/index.js"
import { detect } from "./pattern-detectors/index.js"
import { renderMarkdown } from "./renderers/markdown.js"

export function explain(graph: IntermediateExecutionGraph): Finding[] {
  const facts = extractFacts(graph)
  return detect(facts, graph)
}

export { extractFacts, detect, renderMarkdown }
export type { SemanticFact, Finding }
export * from "./fact-extraction/types.js"
export * from "./findings/types.js"

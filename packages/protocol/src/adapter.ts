import type { IntermediateExecutionGraph } from "./graph.js"

export interface SemanticAdapter {
  parseProject(root: string): IntermediateExecutionGraph[]
}

import type { IntermediateExecutionGraph, ExecutionNode, ExecutionEdge } from "@archmind/protocol"

function serializeNode(node: ExecutionNode): string {
  const argsStr = node.args?.length ? `(${node.args.join(", ")})` : ""
  return `  [${node.type}]  ${node.symbol}${argsStr}`
}

function serializeEdge(edge: ExecutionEdge): string {
  const via = (edge as { via?: string }).via ? `  via: ${(edge as { via?: string }).via}` : ""
  return `  ${edge.from} → ${edge.to}  [${edge.relation}]${via}`
}

export function serializeExecutionPath(graph: IntermediateExecutionGraph): string {
  const header = `Execution path: ${graph.entrypoint}\n`
  const nodes = "Nodes:\n" + graph.nodes.map(serializeNode).join("\n")
  const edges = "Edges:\n" + graph.edges.map(serializeEdge).join("\n")
  return `${header}\n${nodes}\n\n${edges}`
}

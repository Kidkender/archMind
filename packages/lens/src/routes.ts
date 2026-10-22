import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

/**
 * Handler key to routes, built from archMind's route graphs. The graph names a handler by the
 * variable it is registered through ("mailHandler.Get"); lower-casing lets that match the type
 * name in the call graph ("MailHandler.Get").
 */
export function handlerRouteIndex(graphs: IntermediateExecutionGraph[]): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const g of graphs) {
    const handler = g.nodes.find((n) => n.type === "ir:business_handler")
    if (!handler) continue
    const key = handler.symbol.toLowerCase()
    const routes = index.get(key) ?? []
    routes.push(g.entrypoint)
    index.set(key, routes)
  }
  return index
}

import type { IntermediateExecutionGraph, ExecutionNode } from "@archmind/protocol"

// ---- Public API -------------------------------------------------------

export interface DependencyIndex {
  /**
   * Maps exact service symbol → entrypoints that call it.
   * e.g. "OrderService::create" → Set{ "POST /orders", "POST /admin/orders" }
   */
  bySymbol: Map<string, Set<string>>

  /**
   * Maps class name (no method) → entrypoints that call any method on it.
   * e.g. "OrderService" → Set{ "POST /orders", "GET /orders/{id}", ... }
   * Derived automatically from bySymbol at build time.
   */
  byClass: Map<string, Set<string>>

  /** entrypoint → full graph, for callers that need graph context */
  graphsByEntrypoint: Map<string, IntermediateExecutionGraph>
}

export interface DependencyHit {
  entrypoint: string
  graph:      IntermediateExecutionGraph
  /** nodes in this graph whose symbol matches the query */
  matchingNodes: ExecutionNode[]
}

/**
 * Build a cross-route dependency index from a set of augmented graphs.
 *
 * Indexes service_call nodes only (P3 v1).
 * Model writes, events, and form_request impacts are out of scope for v1.
 *
 * Key: node.symbol (e.g. "OrderService::create"), NOT node.id — id is
 * caller-scoped and would explode the index.
 */
export function buildDependencyIndex(
  graphs: IntermediateExecutionGraph[]
): DependencyIndex {
  const bySymbol  = new Map<string, Set<string>>()
  const byClass   = new Map<string, Set<string>>()
  const graphsByEntrypoint = new Map<string, IntermediateExecutionGraph>()

  for (const graph of graphs) {
    graphsByEntrypoint.set(graph.entrypoint, graph)

    for (const node of graph.nodes) {
      if (node.type !== "ir:service_call" && node.type !== "service_call") continue

      const symbol = node.symbol   // e.g. "OrderService::create"
      const cls    = symbol.split("::")[0]  // e.g. "OrderService"
      if (!cls) continue

      // Index by exact symbol
      if (!bySymbol.has(symbol)) bySymbol.set(symbol, new Set())
      bySymbol.get(symbol)!.add(graph.entrypoint)

      // Index by class (union of all methods)
      if (!byClass.has(cls)) byClass.set(cls, new Set())
      byClass.get(cls)!.add(graph.entrypoint)
    }
  }

  return { bySymbol, byClass, graphsByEntrypoint }
}

/**
 * Query which routes depend on a symbol.
 *
 * Supports:
 *   "OrderService::create"  — exact method match
 *   "OrderService"          — all methods on the class (uses byClass index)
 *
 * Returns hits sorted by entrypoint for deterministic output.
 */
export function queryDependents(
  index: DependencyIndex,
  symbol: string
): DependencyHit[] {
  const isExact = symbol.includes("::")
  const entrypoints: Set<string> = isExact
    ? (index.bySymbol.get(symbol) ?? new Set())
    : (index.byClass.get(symbol) ?? new Set())

  const hits: DependencyHit[] = []

  for (const ep of entrypoints) {
    const graph = index.graphsByEntrypoint.get(ep)
    if (!graph) continue

    const matchingNodes = graph.nodes.filter((n) => {
      if (n.type !== "ir:service_call" && n.type !== "service_call") return false
      if (isExact) return n.symbol === symbol
      return n.symbol.startsWith(`${symbol}::`)
    })

    hits.push({ entrypoint: ep, graph, matchingNodes })
  }

  return hits.sort((a, b) => a.entrypoint.localeCompare(b.entrypoint))
}

/**
 * Summarise the dependency index — useful for smoke scripts and diagnostics.
 */
export function indexStats(index: DependencyIndex): {
  totalSymbols:   number
  totalClasses:   number
  totalRoutes:    number
  topSymbols:     { symbol: string; routeCount: number }[]
} {
  const topSymbols = [...index.bySymbol.entries()]
    .map(([symbol, eps]) => ({ symbol, routeCount: eps.size }))
    .sort((a, b) => b.routeCount - a.routeCount)
    .slice(0, 10)

  return {
    totalSymbols: index.bySymbol.size,
    totalClasses: index.byClass.size,
    totalRoutes:  index.graphsByEntrypoint.size,
    topSymbols,
  }
}

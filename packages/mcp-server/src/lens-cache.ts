import { buildCallGraph, handlerRouteIndex, type CallGraph } from "@kidkender/archmind-lens"
import { readGoProjectFiles } from "@kidkender/archmind-go-parser"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { getGraphs } from "./cache.js"

interface LensEntry {
  /** The route graphs the call graph was built next to; getGraphs returns a new array after any .go change. */
  source: IntermediateExecutionGraph[]
  graph: CallGraph
  handlerRoutes: Map<string, string[]>
}

const entries = new Map<string, LensEntry>()

/** Call graph and handler-route index for a Go project, rebuilt whenever the route graphs are re-parsed. */
export function getLens(projectRoot: string): LensEntry {
  const source = getGraphs(projectRoot)
  const cached = entries.get(projectRoot)
  if (cached && cached.source === source) return cached

  const entry: LensEntry = {
    source,
    graph: buildCallGraph(readGoProjectFiles(projectRoot)),
    handlerRoutes: handlerRouteIndex(source),
  }
  entries.set(projectRoot, entry)
  return entry
}

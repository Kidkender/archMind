import { parseRouteFile, augmentGraph, loadProjectConfig } from "@archmind/laravel-parser"
import type { IntermediateExecutionGraph } from "@archmind/protocol"
import { join } from "path"

const cache = new Map<string, IntermediateExecutionGraph[]>()

export function getGraphs(projectRoot: string): IntermediateExecutionGraph[] {
  if (cache.has(projectRoot)) {
    return cache.get(projectRoot)!
  }

  const config = loadProjectConfig(projectRoot)
  const graphs: IntermediateExecutionGraph[] = []

  for (const relRouteFile of config.routeFiles) {
    const routesFile = join(projectRoot, relRouteFile)
    const skeletons = parseRouteFile(routesFile, {})
    for (const g of skeletons) {
      graphs.push(augmentGraph(g, { projectRoot, config }))
    }
  }

  cache.set(projectRoot, graphs)
  return graphs
}

export function invalidate(projectRoot: string): void {
  cache.delete(projectRoot)
}

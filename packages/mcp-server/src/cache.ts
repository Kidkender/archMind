import { parseRouteFile, augmentGraph } from "@archmind/laravel-parser"
import type { IntermediateExecutionGraph } from "@archmind/protocol"

const cache = new Map<string, IntermediateExecutionGraph[]>()

export function getGraphs(projectRoot: string): IntermediateExecutionGraph[] {
  if (cache.has(projectRoot)) {
    return cache.get(projectRoot)!
  }

  const routesFile = `${projectRoot}/routes/api.php`
  const skeletons = parseRouteFile(routesFile, {})
  const graphs = skeletons.map((g) =>
    augmentGraph(g, { projectRoot, permissionConstantFiles: [] })
  )

  cache.set(projectRoot, graphs)
  return graphs
}

export function invalidate(projectRoot: string): void {
  cache.delete(projectRoot)
}

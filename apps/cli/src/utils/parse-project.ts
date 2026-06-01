import { join } from "path"
import {
  parseRouteFile,
  augmentGraph,
  loadProjectConfig,
  resolveAliasMap,
} from "@archmind/laravel-parser"
import type { IntermediateExecutionGraph } from "@archmind/protocol"

export interface ParsedProject {
  graphs:     IntermediateExecutionGraph[]
  routeCount: number
  fileCount:  number
  projectRoot: string
}

export function parseProject(projectRoot: string): ParsedProject {
  const config = loadProjectConfig(projectRoot)
  const { aliasMap, routeFiles } = resolveAliasMap(projectRoot, config)

  const graphs: IntermediateExecutionGraph[] = []
  for (const relFile of routeFiles) {
    const skeletons = parseRouteFile(join(projectRoot, relFile), { aliasMap })
    for (const g of skeletons) {
      graphs.push(augmentGraph(g, { projectRoot, config }))
    }
  }

  return {
    graphs,
    routeCount: graphs.length,
    fileCount:  routeFiles.length,
    projectRoot,
  }
}

export function requireProject(flags: Record<string, string>): string {
  const p = flags["project"]
  if (!p) {
    console.error("Error: --project <path> is required")
    process.exit(2)
  }
  return p
}

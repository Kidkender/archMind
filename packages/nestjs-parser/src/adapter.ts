import type { IntermediateExecutionGraph } from "@archmind/protocol"
import type { SemanticAdapter } from "@archmind/protocol"
import { extractRoutes } from "./extractors/route.extractor.js"
import { emitGraphs } from "./emitters/ir-emitter.js"
import { scanGlobalPipes } from "./resolvers/global.resolver.js"
import { scanGlobalGuards } from "./resolvers/module.resolver.js"

export class NestJSAdapter implements SemanticAdapter {
  parseProject(root: string): IntermediateExecutionGraph[] {
    const globalPipes  = scanGlobalPipes(root)
    const globalGuards = scanGlobalGuards(root)
    const routes = extractRoutes({ projectRoot: root })

    // Prepend APP_GUARD global guards to every non-public route
    const merged = globalGuards.length === 0
      ? routes
      : routes.map(r => r.isPublic ? r : { ...r, guards: [...globalGuards, ...r.guards] })

    return emitGraphs(merged, globalPipes)
  }
}

export function parseNestJSProject(root: string): IntermediateExecutionGraph[] {
  return new NestJSAdapter().parseProject(root)
}

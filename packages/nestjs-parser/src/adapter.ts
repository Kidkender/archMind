import type { IntermediateExecutionGraph } from "@archmind/protocol"
import type { SemanticAdapter } from "@archmind/protocol"
import { extractRoutes } from "./extractors/route.extractor.js"
import { emitGraphs } from "./emitters/ir-emitter.js"
import { scanGlobalPipes } from "./resolvers/global.resolver.js"

export class NestJSAdapter implements SemanticAdapter {
  parseProject(root: string): IntermediateExecutionGraph[] {
    const globalPipes = scanGlobalPipes(root)
    const routes = extractRoutes({ projectRoot: root })
    return emitGraphs(routes, globalPipes)
  }
}

export function parseNestJSProject(root: string): IntermediateExecutionGraph[] {
  return new NestJSAdapter().parseProject(root)
}

import { loadUserConfig } from "@kidkender/archmind-protocol"
import type { IntermediateExecutionGraph, SemanticAdapter } from "@kidkender/archmind-protocol"
import { findExpressRoot } from "./detect.js"
import { readSourceFiles, type SourceFile } from "./scanner.js"
import { createExpressProject } from "./project.js"
import { extractRoutes } from "./routes.js"
import { Evaluator } from "./evaluator.js"
import { analyzeHandler } from "./handler.js"
import { routeToGraph } from "./graph.js"

export interface ParseExpressOptions {
  /** Middleware / function names classified as ir:auth_gate (archmind.json `guards.auth_gate`). */
  authGates?:        string[]
  /** Middleware / function names classified as ir:authz_check (archmind.json `guards.authz_check`). */
  authzChecks?:      string[]
  /** Functions that resolve the caller's own record (archmind.json `authorization.ownershipSources`). */
  ownershipSources?: string[]
}

/**
 * Parses already-read Express sources into one IntermediateExecutionGraph per
 * route. Takes the file list directly so tests can use synthetic fixtures;
 * parseExpressProjectAt reads a project from disk.
 */
export function parseExpressSources(sources: SourceFile[], opts: ParseExpressOptions = {}): IntermediateExecutionGraph[] {
  if (sources.length === 0) return []
  const ep = createExpressProject(sources)
  const ev = new Evaluator(ep)
  const { routes } = extractRoutes(ep, ev)
  const classify = { authGates: opts.authGates, authzChecks: opts.authzChecks }
  return routes.map((r) => routeToGraph(r, classify, analyzeHandler(r, ev, { ownershipSources: opts.ownershipSources })))
}

/**
 * Discovers and parses an Express project on disk (the root itself, or the one
 * directory below it that holds the Express app). Reads archmind.json from the
 * project root; anything passed in `opts` takes precedence.
 */
export function parseExpressProjectAt(root: string, opts: ParseExpressOptions = {}): IntermediateExecutionGraph[] {
  const appRoot = findExpressRoot(root)
  if (!appRoot) return []
  const userConfig = loadUserConfig(root)
  return parseExpressSources(readSourceFiles(appRoot), {
    authGates:        userConfig?.guards?.auth_gate,
    authzChecks:      userConfig?.guards?.authz_check,
    ownershipSources: userConfig?.authorization?.ownershipSources,
    ...opts,
  })
}

export class ExpressAdapter implements SemanticAdapter {
  parseProject(root: string): IntermediateExecutionGraph[] {
    return parseExpressProjectAt(root)
  }
}

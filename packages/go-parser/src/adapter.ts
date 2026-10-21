import { loadUserConfig } from "@kidkender/archmind-protocol"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { readGoProjectFiles, isGinProject } from "./scanner.js"
import { parseGinProject, type ParseGinOptions } from "./graph-builder.js"

export { isGinProject } from "./scanner.js"

/**
 * Discovers and parses an entire Gin project on disk into one
 * IntermediateExecutionGraph per route. This is the entrypoint the CLI/MCP
 * server should call — `parseGinProject` itself takes an already-read file
 * list (used directly in tests with synthetic fixtures).
 *
 * Reads the project's archmind.json for settings (`authorization.
 * ownershipSources`); anything passed in `opts` takes precedence.
 */
export function parseGinProjectAt(root: string, opts: ParseGinOptions = {}): IntermediateExecutionGraph[] {
  const userConfig = loadUserConfig(root)
  const files = readGoProjectFiles(root)
  return parseGinProject(files, {
    ownershipSources: userConfig?.authorization?.ownershipSources,
    ...opts,
  })
}

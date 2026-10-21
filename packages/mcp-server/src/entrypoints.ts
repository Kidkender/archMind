import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

export interface EntrypointSummary {
  entrypoint: string
  method: string
  path: string
  node_count: number
  edge_count: number
  /** Handler declaration site, relative to project root. Absent when the parser did not record it. */
  file?: string
  line?: number
}

/**
 * One row per route, with the handler's file:line so an agent can Read it directly.
 * `filter` is a case-insensitive substring matched against the entrypoint and handler file.
 */
export function summarizeEntrypoints(
  graphs: IntermediateExecutionGraph[],
  filter?: string
): EntrypointSummary[] {
  const needle = filter?.trim().toLowerCase()

  return graphs
    .map((g): EntrypointSummary => {
      const handler = g.nodes.find((n) => n.type === "ir:business_handler")
      return {
        entrypoint: g.entrypoint,
        method: g.method,
        path: g.path,
        node_count: g.nodes.length,
        edge_count: g.edges.length,
        ...(handler?.file !== undefined && { file: handler.file }),
        ...(handler?.line !== undefined && { line: handler.line }),
      }
    })
    .filter((e) => !needle || `${e.entrypoint} ${e.file ?? ""}`.toLowerCase().includes(needle))
}

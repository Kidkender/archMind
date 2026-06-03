import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { getGraphs, invalidate, detectFramework } from "./cache.js"
import { retrieve, buildDependencyIndex, queryDependents, indexStats } from "@archmind/retrieval"
import { explain } from "@archmind/explainer"
import type { RetrievalFocus } from "@archmind/protocol"
import { PROTOCOL_VERSION } from "@archmind/protocol"
import { ingestOtlpFile } from "@archmind/runtime-ingest"
import { correlateSession, detectNPlusOne, detectSlowQuery } from "@archmind/runtime-correlator"

const FOCUS_VALUES = ["auth", "validation", "runtime", "transaction", "isolation", "all"] as const

export function createServer(): McpServer {
  const server = new McpServer({
    name: "archmind",
    version: "0.2.0",
  })

  server.registerTool(
    "archmind_detect_framework",
    {
      description: "Detect whether a project is Laravel or NestJS. Call this first if you are unsure which framework the project uses.",
      inputSchema: {
        project_root: z.string().describe("Absolute path to the project root"),
      },
    },
    async ({ project_root }) => {
      const framework = detectFramework(project_root)
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ project_root, framework }, null, 2),
        }],
      }
    }
  )

  server.registerTool(
    "archmind_list_entrypoints",
    {
      description: "List all HTTP entrypoints (routes) in a Laravel or NestJS project, with method, path, and node count. Framework is auto-detected from the project root.",
      inputSchema: {
        project_root: z.string().describe("Absolute path to the project root (Laravel or NestJS)"),
      },
    },
    async ({ project_root }) => {
      const graphs = getGraphs(project_root)
      const entrypoints = graphs.map((g) => ({
        entrypoint: g.entrypoint,
        method: g.method,
        path: g.path,
        node_count: g.nodes.length,
        edge_count: g.edges.length,
      }))
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ project_root, entrypoints, total: entrypoints.length }, null, 2),
          },
        ],
      }
    }
  )

  server.registerTool(
    "archmind_get_execution_graph",
    {
      description:
        "Return the semantic execution graph for a specific entrypoint in a Laravel or NestJS project. Use `focus` to narrow to a concern (auth, validation, runtime, transaction, isolation, all). Framework is auto-detected.",
      inputSchema: {
        project_root: z.string().describe("Absolute path to the project root (Laravel or NestJS)"),
        entrypoint: z.string().describe('Entrypoint in "METHOD /path" format, e.g. "PUT /tasks/{task}"'),
        focus: z
          .enum(FOCUS_VALUES)
          .optional()
          .describe("Semantic focus to prune the graph. Defaults to 'all' (full graph)."),
      },
    },
    async ({ project_root, entrypoint, focus }) => {
      const graphs = getGraphs(project_root)
      const graph = graphs.find((g) => g.entrypoint === entrypoint)
      if (!graph) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `No graph found for entrypoint: ${entrypoint}` }),
            },
          ],
          isError: true,
        }
      }

      const resolvedFocus: RetrievalFocus = (focus as RetrievalFocus) ?? "all"
      const retrieved = retrieve({ entrypoint, focus: resolvedFocus }, graphs)

      const result = retrieved ?? {
        entrypoint:       graph.entrypoint,
        nodes:            graph.nodes,
        edges:            graph.edges,
        token_estimate:   Math.ceil(
          JSON.stringify({ nodes: graph.nodes, edges: graph.edges }).length / 4
        ),
        pruned:           false,
        focus:            resolvedFocus,
        protocol_version: PROTOCOL_VERSION,
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                entrypoint: result.entrypoint,
                focus: resolvedFocus,
                pruned: result.pruned,
                token_estimate: result.token_estimate,
                nodes: result.nodes,
                edges: result.edges,
                annotations: graph.annotations,
              },
              null,
              2
            ),
          },
        ],
      }
    }
  )

  server.registerTool(
    "archmind_get_findings",
    {
      description:
        "Run static and optional runtime pattern detectors on the execution graph and return semantic findings (no LLM call). Findings include security issues, authorization gaps, transaction anomalies, isolation violations, and — when a trace session is provided — runtime findings like N+1 queries and slow queries.",
      inputSchema: {
        project_root: z.string().describe("Absolute path to the project root (Laravel or NestJS)"),
        entrypoint: z.string().describe('Entrypoint in "METHOD /path" format, e.g. "PUT /tasks/{task}" or "GET /users/:id"'),
        query: z
          .string()
          .optional()
          .describe("Optional question to prioritize findings by relevance to the query."),
        trace_session_path: z
          .string()
          .optional()
          .describe("Absolute path to an OTLP JSON export file. When provided, runtime findings (N+1, slow queries) are included alongside static findings."),
      },
    },
    async ({ project_root, entrypoint, query, trace_session_path }) => {
      const graphs = getGraphs(project_root)
      const graph = graphs.find((g) => g.entrypoint === entrypoint)
      if (!graph) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `No graph found for entrypoint: ${entrypoint}` }),
            },
          ],
          isError: true,
        }
      }

      const staticFindings = explain(graph, query)

      // Runtime findings (optional)
      let runtimeFindings: Array<{ source: "runtime"; type: string; severity: string; evidence: string; nodeIds: string[]; count?: number }> = []
      let correlationRate: number | undefined

      if (trace_session_path) {
        try {
          const traceSession  = ingestOtlpFile(trace_session_path)
          const correlated    = correlateSession(traceSession, graph)
          correlationRate     = correlated.correlationRate
          const n1            = detectNPlusOne(correlated)
          const slow          = detectSlowQuery(correlated)
          runtimeFindings     = [...n1, ...slow].map((f) => ({
            source:   "runtime" as const,
            type:     f.type,
            severity: f.severity,
            evidence: f.evidence,
            nodeIds:  f.nodeIds,
            ...(f.count !== undefined ? { count: f.count } : {}),
          }))
        } catch (err) {
          runtimeFindings = []
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                entrypoint,
                static_findings: {
                  total: staticFindings.length,
                  findings: staticFindings.map((f) => ({
                    id:              f.id,
                    type:            f.type,
                    severity:        f.severity,
                    confidence:      f.confidence,
                    summary:         f.summary,
                    evidence:        f.evidence,
                    recommendations: f.recommendations ?? [],
                    uncertainty:     f.uncertainty ?? [],
                  })),
                },
                ...(trace_session_path
                  ? {
                      runtime_findings: {
                        total:            runtimeFindings.length,
                        correlation_rate: correlationRate,
                        findings:         runtimeFindings,
                      },
                    }
                  : {}),
              },
              null,
              2
            ),
          },
        ],
      }
    }
  )

  server.registerTool(
    "archmind_get_dependents",
    {
      description:
        "Find all routes that depend on a service class or method. " +
        "Use to answer 'What breaks if I change X?' or 'Which routes call OrderService?'. " +
        "Pass a class name (e.g. 'OrderService') for all methods, or a full symbol " +
        "(e.g. 'OrderService::create') for a specific method.",
      inputSchema: {
        project_root: z.string().describe("Absolute path to the project root (Laravel or NestJS)"),
        symbol: z
          .string()
          .describe(
            "Service class or method to query. Examples: 'CartService', 'PaymentService::refund'"
          ),
      },
    },
    async ({ project_root, symbol }) => {
      const graphs = getGraphs(project_root)
      const index  = buildDependencyIndex(graphs)
      const hits   = queryDependents(index, symbol)
      const stats  = indexStats(index)

      const result = {
        symbol,
        project_root,
        dependent_routes: hits.map((h) => ({
          entrypoint:     h.entrypoint,
          matching_nodes: h.matchingNodes.map((n) => ({ symbol: n.symbol, type: n.type, file: n.file })),
        })),
        total_dependents: hits.length,
        index_stats: {
          total_symbols: stats.totalSymbols,
          total_classes: stats.totalClasses,
        },
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    }
  )

  server.registerTool(
    "archmind_invalidate_cache",
    {
      description:
        "Invalidate the cached parse result for a project root, forcing a fresh parse on the next call. Use when the project's source files have changed.",
      inputSchema: {
        project_root: z.string().describe("Absolute path to the project root (Laravel or NestJS)"),
      },
    },
    async ({ project_root }) => {
      invalidate(project_root)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ invalidated: true, project_root }),
          },
        ],
      }
    }
  )

  return server
}

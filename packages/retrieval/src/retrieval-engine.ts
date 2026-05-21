import type {
  IntermediateExecutionGraph,
  ExecutionNode,
  ExecutionEdge,
  RetrievalRequest,
  RetrievalResult,
} from "@archmind/protocol"

export type RetrievalRelevance = "HIGH" | "MEDIUM" | "LOW"

export type RetrievalFocus = "auth" | "validation" | "runtime" | "all"

// Focus → minimum relevance level for each semantic section.
// Nodes below threshold are pruned; the rest are kept intact.
const FOCUS_THRESHOLD: Record<RetrievalFocus, RetrievalRelevance> = {
  auth:       "HIGH",    // only auth-critical nodes
  validation: "MEDIUM",  // validation + auth context
  runtime:    "MEDIUM",  // runtime injection + middleware
  all:        "LOW",     // everything (R0 behaviour)
}

// ---- Public API -------------------------------------------------------

export function retrieve(
  request: RetrievalRequest & { focus?: RetrievalFocus },
  graphs: IntermediateExecutionGraph[]
): RetrievalResult | null {
  const graph = findGraph(request.entrypoint, graphs)
  if (!graph) return null

  const r0: RetrievalResult = {
    entrypoint:     graph.entrypoint,
    nodes:          graph.nodes,
    edges:          graph.edges,
    token_estimate: estimateTokens(graph.nodes, graph.edges),
    pruned:         false,
  }

  const focus = request.focus ?? "all"
  if (focus === "all") return r0
  return prune(r0, FOCUS_THRESHOLD[focus])
}

export function prune(
  result: RetrievalResult,
  minRelevance: RetrievalRelevance
): RetrievalResult {
  const threshold = RELEVANCE_ORDER[minRelevance]

  const keptNodes = result.nodes.filter(
    (n) => RELEVANCE_ORDER[classifyNode(n)] >= threshold
  )
  const keptIds   = new Set(keptNodes.map((n) => n.id))
  const keptEdges = result.edges.filter(
    (e) => keptIds.has(e.from) && keptIds.has(e.to)
  )

  return {
    entrypoint:     result.entrypoint,
    nodes:          keptNodes,
    edges:          keptEdges,
    token_estimate: estimateTokens(keptNodes, keptEdges),
    pruned:         true,
  }
}

// ---- Node type → relevance classification ----------------------------
// Derived from golden trace patterns across all 4 pain cases.

const NODE_TYPE_RELEVANCE: Record<string, RetrievalRelevance> = {
  // Always semantically critical
  policy:              "HIGH",
  permission:          "HIGH",
  authentication_gate: "HIGH",
  authorization_check: "HIGH",
  runtime_injection:   "HIGH",
  service_call:        "HIGH",

  // Important context — carry structural meaning
  form_request:        "MEDIUM",
  controller_action:   "MEDIUM",
  controller:          "MEDIUM",
  middleware:          "MEDIUM",
}

const RELEVANCE_ORDER: Record<RetrievalRelevance, number> = {
  HIGH:   2,
  MEDIUM: 1,
  LOW:    0,
}

export function classifyNode(node: ExecutionNode): RetrievalRelevance {
  return NODE_TYPE_RELEVANCE[node.type] ?? "LOW"
}

// ---- Entrypoint matching ----------------------------------------------

function normalizeEntrypoint(ep: string): string {
  return ep.replace(/\{[^}]+\}/g, "{*}")
}

function findGraph(
  entrypoint: string,
  graphs: IntermediateExecutionGraph[]
): IntermediateExecutionGraph | null {
  const norm = normalizeEntrypoint(entrypoint)
  return graphs.find((g) => normalizeEntrypoint(g.entrypoint) === norm) ?? null
}

// ---- Token estimation -------------------------------------------------

function estimateTokens(nodes: ExecutionNode[], edges: ExecutionEdge[]): number {
  return Math.ceil(JSON.stringify({ nodes, edges }).length / 4)
}

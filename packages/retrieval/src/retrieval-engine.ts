import type {
  IntermediateExecutionGraph,
  ExecutionNode,
  ExecutionEdge,
  RetrievalRequest,
  RetrievalResult,
  RetrievalFocus,
} from "@archmind/protocol"
import { PROTOCOL_VERSION } from "@archmind/protocol"

export type RetrievalRelevance = "HIGH" | "MEDIUM" | "LOW"

// Re-export so existing consumers don't break
export type { RetrievalFocus }

// Focus → minimum relevance level for each semantic section.
// Nodes below threshold are pruned; the rest are kept intact.
const FOCUS_THRESHOLD: Record<RetrievalFocus, RetrievalRelevance> = {
  auth:        "HIGH",    // only auth-critical nodes
  validation:  "MEDIUM",  // validation + auth context
  runtime:     "MEDIUM",  // runtime injection + middleware
  transaction: "HIGH",    // transaction boundary + escapes only
  isolation:   "HIGH",    // unscoped query + tenant injection only
  all:         "LOW",     // everything (R0 behaviour)
}

// Node types where repeated occurrences carry no additional semantic meaning
// and are safe to merge. Caller-scoped types (service_call, policy, permission,
// form_request, etc.) must NOT be deduplicated.
const DEDUP_TYPES = new Set([
  "transaction_boundary",
  "transactional_write",
  "transaction_escape",
  "unscoped_query",
  "tenant_scoped_query",
])

// Rough token budget: if graph exceeds this after dedup, prune by relevance.
const TOKEN_BUDGET = 2500

// ---- Public API -------------------------------------------------------

export function retrieve(
  request: RetrievalRequest,
  graphs: IntermediateExecutionGraph[]
): RetrievalResult | null {
  const graph = findGraph(request.entrypoint, graphs)
  if (!graph) return null

  const focus: RetrievalFocus = request.focus ?? "all"

  let result: RetrievalResult = {
    entrypoint:       graph.entrypoint,
    nodes:            graph.nodes,
    edges:            graph.edges,
    token_estimate:   estimateTokens(graph.nodes, graph.edges),
    pruned:           false,
    focus,
    protocol_version: PROTOCOL_VERSION,
  }

  result = deduplicate(result)

  if (focus !== "all") {
    result = prune(result, FOCUS_THRESHOLD[focus])
  }

  if (result.token_estimate > TOKEN_BUDGET && !result.pruned) {
    result = prune(result, "MEDIUM")
  }

  return result
}

export function deduplicate(result: RetrievalResult): RetrievalResult {
  // Map from original node ID → canonical node ID (for edge remapping)
  const idToCanonical = new Map<string, string>()
  // Map from dedup key → canonical node (first seen)
  const canonicalByKey = new Map<string, ExecutionNode>()
  const deduped: ExecutionNode[] = []

  for (const node of result.nodes) {
    if (!DEDUP_TYPES.has(node.type)) {
      idToCanonical.set(node.id, node.id)
      deduped.push(node)
      continue
    }

    const key = `${node.type}|${node.symbol}|${(node.args ?? []).join(",")}`
    const existing = canonicalByKey.get(key)

    if (!existing) {
      const canonical: ExecutionNode = { ...node, occurrenceCount: 1 }
      canonicalByKey.set(key, canonical)
      deduped.push(canonical)
      idToCanonical.set(node.id, node.id)
    } else {
      existing.occurrenceCount = (existing.occurrenceCount ?? 1) + 1
      idToCanonical.set(node.id, existing.id)
    }
  }

  // Remap edges to canonical IDs and deduplicate identical edges
  const seenEdgeKeys = new Set<string>()
  const remappedEdges: ExecutionEdge[] = []

  for (const edge of result.edges) {
    const from = idToCanonical.get(edge.from) ?? edge.from
    const to   = idToCanonical.get(edge.to)   ?? edge.to
    const edgeKey = `${from}|${to}|${edge.relation}`
    if (seenEdgeKeys.has(edgeKey)) continue
    seenEdgeKeys.add(edgeKey)
    remappedEdges.push({ ...edge, from, to })
  }

  return {
    ...result,
    nodes:          deduped,
    edges:          remappedEdges,
    token_estimate: estimateTokens(deduped, remappedEdges),
  }
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
    entrypoint:       result.entrypoint,
    nodes:            keptNodes,
    edges:            keptEdges,
    token_estimate:   estimateTokens(keptNodes, keptEdges),
    pruned:           true,
    focus:            result.focus,
    protocol_version: result.protocol_version,
  }
}

// ---- Node type → relevance classification ----------------------------
// Derived from golden trace patterns across all 4 pain cases.

const NODE_TYPE_RELEVANCE: Record<string, RetrievalRelevance> = {
  // Always semantically critical
  policy:               "HIGH",
  permission:           "HIGH",
  authentication_gate:  "HIGH",
  authorization_check:  "HIGH",
  runtime_injection:    "HIGH",
  service_call:         "HIGH",

  // Transaction semantics — all HIGH (boundary + escape are the danger zone)
  transaction_boundary: "HIGH",
  transactional_write:  "HIGH",
  transaction_escape:   "HIGH",

  // Isolation semantics — unscoped query is the critical signal
  unscoped_query:       "HIGH",
  tenant_scoped_query:  "MEDIUM",

  // FormRequest::authorize is an authorization gate — HIGH for auth focus
  form_request:         "HIGH",
  controller_action:    "MEDIUM",
  controller:           "MEDIUM",
  middleware:           "MEDIUM",

  // Service-layer expansion nodes (Phase 4)
  service_method:       "HIGH",   // service entry point when expanded
  repository_call:      "HIGH",   // explicit repository class calls
  model_operation:      "MEDIUM", // direct Eloquent model calls in service context
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

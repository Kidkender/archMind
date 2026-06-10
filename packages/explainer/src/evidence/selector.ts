import type { IntermediateExecutionGraph, ExecutionNode } from "@archmind/protocol"
import type { Finding } from "../findings/types.js"
import type { EvidenceItem } from "./types.js"

// Map IR node type → human role label
const TYPE_ROLE: Record<string, string> = {
  "ir:auth_gate":          "middleware",
  "ir:authz_check":        "policy",
  "ir:business_handler":   "controller",
  "ir:validation_gate":    "form_request",
  "ir:service_call":       "service",
  "ir:permission_constant":"permission",
  "ir:resource":           "resource",
  "ir:runtime_inject":     "runtime_injector",
  "ir:runtime_consume":    "runtime_consumer",
  "ir:tenant_context":     "tenant_context",
  "ir:scoped_query":       "scoped_query",
  "ir:unscoped_query":     "unscoped_query",
  "ir:unscoped_write":     "unscoped_write",
  "ir:txn_boundary":       "transaction",
  "ir:txn_write":          "txn_write",
  "ir:txn_escape":         "txn_escape",
}

function nodeRole(node: ExecutionNode): string {
  return TYPE_ROLE[node.type] ?? node.type.replace("ir:", "")
}

function nodeDetail(node: ExecutionNode): string | undefined {
  if (node.role && node.role !== nodeRole(node)) return node.role
  if (node.args && node.args.length > 0) return node.args.join(", ")
  return undefined
}

// Focus → node types that should always be included for context
const FOCUS_NODE_TYPES: Record<string, string[]> = {
  auth: [
    "ir:auth_gate", "ir:authz_check", "ir:business_handler",
    "ir:validation_gate", "ir:permission_constant", "ir:resource",
  ],
  validation:  ["ir:validation_gate", "ir:business_handler"],
  runtime:     ["ir:runtime_inject", "ir:runtime_consume", "ir:tenant_context"],
  transaction: ["ir:txn_boundary", "ir:txn_write", "ir:txn_escape"],
  isolation:   ["ir:scoped_query", "ir:unscoped_query", "ir:unscoped_write", "ir:tenant_context"],
  all:         [],
}

export function selectEvidence(
  finding: Finding,
  graph: IntermediateExecutionGraph,
  focus = "all"
): EvidenceItem[] {
  // Gather unique node IDs from finding evidence + supporting nodes
  const nodeIds = new Set<string>([
    ...finding.provenance.supporting_nodes,
    ...finding.evidence.map((e) => e.nodeId),
  ])

  // Enrich with all nodes relevant to the query focus (union, not replace)
  const focusTypes = new Set(FOCUS_NODE_TYPES[focus] ?? [])
  for (const node of graph.nodes) {
    if (focusTypes.has(node.type)) nodeIds.add(node.id)
  }

  const items: EvidenceItem[] = []

  for (const id of nodeIds) {
    const node = graph.nodes.find((n) => n.id === id)
    if (!node) continue

    const evidenceEntry = finding.evidence.find((e) => e.nodeId === id)

    items.push({
      nodeId: node.id,
      symbol: node.symbol,
      type: node.type,
      role: nodeRole(node),
      detail: evidenceEntry?.detail ?? nodeDetail(node),
    })
  }

  return items
}

// BFS from entrypoint (or first node) following directed edges to produce
// an ordered execution path. Returns node IDs in traversal order.
export function buildExecutionPath(graph: IntermediateExecutionGraph): string[] {
  if (graph.nodes.length === 0) return []

  // Prefer explicit entrypoint node, else first auth_gate, else first node
  const entrypoint =
    graph.nodes.find((n) => n.type === "ir:entrypoint") ??
    graph.nodes.find((n) => n.type === "ir:auth_gate") ??
    graph.nodes[0]

  const visited = new Set<string>()
  const order: string[] = []
  const queue: string[] = [entrypoint.id]

  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    order.push(current)

    // Follow outgoing edges in insertion order
    for (const edge of graph.edges) {
      if (edge.from === current && !visited.has(edge.to)) {
        queue.push(edge.to)
      }
    }
  }

  return order
}

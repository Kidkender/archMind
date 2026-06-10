import type { IntermediateExecutionGraph } from "@archmind/protocol"
import { IR_NODE_TYPES, IR_EDGE_RELATIONS } from "@archmind/protocol"
import { buildExecutionPath } from "../evidence/selector.js"
import type {
  TracePattern,
  AuthTraceEntry,
  EventTraceEntry,
  TransactionTraceEntry,
  IsolationTraceEntry,
  RequestTraceEntry,
  TraceResult,
} from "./types.js"

// ---- Auth trace ------------------------------------------------------------

function traceAuth(graphs: IntermediateExecutionGraph[]): TraceResult<AuthTraceEntry> {
  const results: AuthTraceEntry[] = []

  for (const g of graphs) {
    const auth_gates       = g.nodes.filter((n) => n.type === IR_NODE_TYPES.AUTH_GATE).map((n) => n.symbol)
    const authz_checks     = g.nodes.filter((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK).map((n) => n.symbol)
    const validation_gates = g.nodes.filter((n) => n.type === IR_NODE_TYPES.VALIDATION_GATE).map((n) => n.symbol)
    const resourceNodes    = g.nodes.filter((n) => n.type === IR_NODE_TYPES.RESOURCE)
    const resources        = resourceNodes.map((n) => n.symbol)

    const authorizedSymbols = new Set(
      g.edges
        .filter((e) => e.relation === IR_EDGE_RELATIONS.AUTHORIZES)
        .flatMap((e) => {
          const r = g.nodes.find((n) => n.id === e.to)
          return r ? [r.symbol] : []
        })
    )
    const unprotected_resources = resources.filter((r) => !authorizedSymbols.has(r))

    results.push({
      entrypoint: g.entrypoint,
      auth_gates,
      authz_checks,
      validation_gates,
      resources,
      unprotected_resources,
      has_auth: auth_gates.length > 0 || authz_checks.length > 0,
    })
  }

  return {
    pattern: "auth",
    total_routes: graphs.length,
    results,
    summary: {
      routes_with_auth:                  results.filter((r) => r.has_auth).length,
      routes_without_auth:               results.filter((r) => !r.has_auth).length,
      routes_with_unprotected_resources: results.filter((r) => r.unprotected_resources.length > 0).length,
    },
  }
}

// ---- Event trace -----------------------------------------------------------

function traceEvent(graphs: IntermediateExecutionGraph[]): TraceResult<EventTraceEntry> {
  const results: EventTraceEntry[] = []

  for (const g of graphs) {
    const escapeNodes = g.nodes.filter((n) => n.type === IR_NODE_TYPES.TXN_ESCAPE)
    if (escapeNodes.length === 0) continue

    const inside_transaction = g.nodes.some((n) => n.type === IR_NODE_TYPES.TXN_BOUNDARY)

    results.push({
      entrypoint: g.entrypoint,
      dispatched_events: escapeNodes.map((n) => n.symbol),
      inside_transaction,
    })
  }

  return {
    pattern: "event",
    total_routes: graphs.length,
    results,
    summary: {
      routes_dispatching_events:  results.length,
      routes_with_unsafe_dispatch: results.filter((r) => !r.inside_transaction).length,
    },
  }
}

// ---- Transaction trace -----------------------------------------------------

function traceTransaction(graphs: IntermediateExecutionGraph[]): TraceResult<TransactionTraceEntry> {
  const results: TransactionTraceEntry[] = []

  for (const g of graphs) {
    const boundaries = g.nodes.filter((n) => n.type === IR_NODE_TYPES.TXN_BOUNDARY).map((n) => n.symbol)
    if (boundaries.length === 0) continue

    const writes  = g.nodes.filter((n) => n.type === IR_NODE_TYPES.TXN_WRITE).map((n) => n.symbol)
    const escapes = g.nodes.filter((n) => n.type === IR_NODE_TYPES.TXN_ESCAPE).map((n) => n.symbol)

    results.push({ entrypoint: g.entrypoint, boundaries, writes, escapes })
  }

  return {
    pattern: "transaction",
    total_routes: graphs.length,
    results,
    summary: {
      routes_with_transactions: results.length,
      routes_with_escapes:      results.filter((r) => r.escapes.length > 0).length,
    },
  }
}

// ---- Isolation trace -------------------------------------------------------

function traceIsolation(graphs: IntermediateExecutionGraph[]): TraceResult<IsolationTraceEntry> {
  const results: IsolationTraceEntry[] = []

  for (const g of graphs) {
    const unscoped_queries = g.nodes.filter((n) => n.type === IR_NODE_TYPES.UNSCOPED_QUERY).map((n) => n.symbol)
    const unscoped_writes  = g.nodes.filter((n) => n.type === IR_NODE_TYPES.UNSCOPED_WRITE).map((n) => n.symbol)
    const has_tenant_context = g.nodes.some((n) => n.type === IR_NODE_TYPES.TENANT_CONTEXT)

    if (unscoped_queries.length === 0 && unscoped_writes.length === 0) continue

    results.push({ entrypoint: g.entrypoint, unscoped_queries, unscoped_writes, has_tenant_context })
  }

  return {
    pattern: "isolation",
    total_routes: graphs.length,
    results,
    summary: {
      routes_with_unscoped_queries:      results.filter((r) => r.unscoped_queries.length > 0).length,
      routes_with_unscoped_writes:       results.filter((r) => r.unscoped_writes.length > 0).length,
      routes_without_tenant_context:     results.filter((r) => !r.has_tenant_context).length,
    },
  }
}

// ---- Request trace (single route) -----------------------------------------

function traceRequest(
  graphs: IntermediateExecutionGraph[],
  entrypoint: string
): TraceResult<RequestTraceEntry> {
  const TYPE_ROLE: Record<string, string> = {
    "ir:auth_gate":        "middleware",
    "ir:authz_check":      "policy",
    "ir:business_handler": "controller",
    "ir:validation_gate":  "form_request",
    "ir:service_call":     "service",
    "ir:resource":         "resource",
    "ir:txn_boundary":     "transaction",
    "ir:txn_write":        "txn_write",
    "ir:txn_escape":       "event",
    "ir:unscoped_query":   "unscoped_query",
    "ir:unscoped_write":   "unscoped_write",
    "ir:tenant_context":   "tenant_context",
  }

  const graph = graphs.find((g) => g.entrypoint === entrypoint)
  if (!graph) {
    return { pattern: "request", total_routes: graphs.length, results: [], summary: {} }
  }

  const path = buildExecutionPath(graph)
  const execution_path = path.map((id) => {
    const node = graph.nodes.find((n) => n.id === id)!
    return {
      nodeId: node.id,
      symbol: node.symbol,
      type: node.type,
      role: TYPE_ROLE[node.type] ?? node.type.replace("ir:", ""),
    }
  })

  return {
    pattern: "request",
    total_routes: graphs.length,
    results: [{ entrypoint, execution_path }],
    summary: { total_nodes: execution_path.length },
  }
}

// ---- Public API ------------------------------------------------------------

export function traceByPattern(
  pattern: TracePattern,
  graphs: IntermediateExecutionGraph[],
  entrypoint?: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): TraceResult<any, any> {
  switch (pattern) {
    case "auth":        return traceAuth(graphs)
    case "event":       return traceEvent(graphs)
    case "transaction": return traceTransaction(graphs)
    case "isolation":   return traceIsolation(graphs)
    case "request":     return traceRequest(graphs, entrypoint ?? "")
  }
}

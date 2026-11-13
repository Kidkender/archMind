import { IR_NODE_TYPES, IR_EDGE_RELATIONS, IR_VERSION } from "@kidkender/archmind-protocol"
import type { IntermediateExecutionGraph, ExecutionNode, ExecutionEdge } from "@kidkender/archmind-protocol"
import type { ExpressRoute } from "./routes.js"
import { classifyMiddleware, type ClassifyOptions, type MiddlewareKind } from "./middleware.js"
import type { HandlerFacts } from "./handler.js"

const ADAPTER_VERSION = "0.1.0"

const NODE_FOR_KIND: Partial<Record<MiddlewareKind, { type: string; role: string }>> = {
  auth_gate:       { type: IR_NODE_TYPES.AUTH_GATE,          role: "authentication" },
  authz_check:     { type: IR_NODE_TYPES.AUTHZ_CHECK,        role: "authorization" },
  validation_gate: { type: IR_NODE_TYPES.VALIDATION_GATE,    role: "validation" },
  // no IR node type for these: kept visible as unknown middleware with their role
  rate_limit:      { type: IR_NODE_TYPES.UNKNOWN_MIDDLEWARE, role: "rate_limiting" },
  optional_auth:   { type: IR_NODE_TYPES.UNKNOWN_MIDDLEWARE, role: "optional_authentication" },
  csrf:            { type: IR_NODE_TYPES.UNKNOWN_MIDDLEWARE, role: "csrf" },
  unknown:         { type: IR_NODE_TYPES.UNKNOWN_MIDDLEWARE, role: "middleware" },
  // infrastructure and error handlers get no node
}

/**
 * One graph per route: its middleware in execution order, then the handler,
 * linked by `precedes`. Middleware is classified (classifyMiddleware);
 * infrastructure such as body parsers, logging and CORS is left out.
 */
export function routeToGraph(route: ExpressRoute, opts: ClassifyOptions = {}, facts?: HandlerFacts): IntermediateExecutionGraph {
  const nodes: ExecutionNode[] = []
  for (const mw of route.middleware) {
    const kinds = classifyMiddleware(mw, opts).kinds
    // `auth("manageUsers")` is one check in two parts: the roles belong to the
    // authorization node only, or the permission reads as checked twice
    const split = kinds.includes("auth_gate") && kinds.includes("authz_check")
    for (const kind of kinds) {
      const spec = NODE_FOR_KIND[kind]
      if (!spec) continue
      const withArgs = mw.args.length > 0 && !(split && kind === "auth_gate")
      nodes.push({
        id:     `mw_${nodes.length}`,
        type:   spec.type,
        symbol: shorten(mw.text),
        file:   mw.file,
        line:   mw.line,
        ...(withArgs ? { args: mw.args } : {}),
        role:   spec.role,
      })
    }
  }
  nodes.push({
    id:     "handler",
    type:   IR_NODE_TYPES.BUSINESS_HANDLER,
    symbol: route.handler.symbol,
    file:   route.handler.file,
    line:   route.handler.line,
    role:   "handler",
  })

  // Ownership and the transaction happen inside the handler (or a service it
  // calls), so like the Go adapter they follow the handler in the chain.
  if (facts?.ownership) {
    nodes.push({ id: "ownership", type: IR_NODE_TYPES.AUTHZ_CHECK, ...facts.ownership, role: "authorization" })
  }
  const txn = facts?.transactions[0]
  if (txn) nodes.push({ id: "txn", type: IR_NODE_TYPES.TXN_BOUNDARY, symbol: txn.symbol, file: txn.file, line: txn.line, role: "transaction" })

  const edges: ExecutionEdge[] = []
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ from: nodes[i].id, to: nodes[i + 1].id, relation: IR_EDGE_RELATIONS.PRECEDES, traceability: "static" })
  }

  // Writes inside the transaction hang off it, as Laravel's and NestJS's do.
  for (const [i, w] of (txn?.writes ?? []).entries()) {
    nodes.push({ id: `txn_write_${i}`, type: IR_NODE_TYPES.TXN_WRITE, symbol: w.symbol, file: w.file, line: w.line, role: "persistence", mutates: true })
    edges.push({ from: "txn", to: `txn_write_${i}`, relation: IR_EDGE_RELATIONS.WRAPS, traceability: "static" })
  }

  // Services the handler calls hang off it, outside the chain.
  for (const [i, svc] of (facts?.services ?? []).entries()) {
    nodes.push({ id: `svc_${i}`, type: IR_NODE_TYPES.SERVICE_CALL, ...svc, role: "service" })
    edges.push({ from: "handler", to: `svc_${i}`, relation: IR_EDGE_RELATIONS.CALLS, traceability: "static" })
  }

  return {
    entrypoint:  `${route.method} ${route.path}`,
    method:      route.method,
    path:        route.path,
    nodes,
    edges,
    annotations: [],
    framework:   "express",
    ir_ver:      IR_VERSION,
    adapter_ver: ADAPTER_VERSION,
  }
}

/** Inline middleware can be long: keep the first line, at most 100 characters. */
function shorten(text: string): string {
  return text.length > 100 ? `${text.slice(0, 97)}...` : text
}

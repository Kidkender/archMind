import { IR_NODE_TYPES, IR_EDGE_RELATIONS, IR_VERSION } from "@kidkender/archmind-protocol"
import type { IntermediateExecutionGraph, ExecutionNode, ExecutionEdge } from "@kidkender/archmind-protocol"
import type { ExpressRoute } from "./routes.js"
import { classifyMiddleware, type ClassifyOptions, type MiddlewareKind } from "./middleware.js"

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
export function routeToGraph(route: ExpressRoute, opts: ClassifyOptions = {}): IntermediateExecutionGraph {
  const nodes: ExecutionNode[] = []
  for (const mw of route.middleware) {
    for (const kind of classifyMiddleware(mw, opts).kinds) {
      const spec = NODE_FOR_KIND[kind]
      if (!spec) continue
      nodes.push({
        id:     `mw_${nodes.length}`,
        type:   spec.type,
        symbol: shorten(mw.text),
        file:   mw.file,
        line:   mw.line,
        ...(mw.args.length > 0 ? { args: mw.args } : {}),
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

  const edges: ExecutionEdge[] = []
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ from: nodes[i].id, to: nodes[i + 1].id, relation: IR_EDGE_RELATIONS.PRECEDES, traceability: "static" })
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

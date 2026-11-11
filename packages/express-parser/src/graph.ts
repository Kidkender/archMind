import { IR_NODE_TYPES, IR_EDGE_RELATIONS, IR_VERSION } from "@kidkender/archmind-protocol"
import type { IntermediateExecutionGraph, ExecutionNode, ExecutionEdge } from "@kidkender/archmind-protocol"
import type { ExpressRoute } from "./routes.js"

const ADAPTER_VERSION = "0.1.0"

/**
 * One graph per route: its middleware in execution order, then the handler,
 * linked by `precedes`. Middleware is ir:unknown_middleware until it is
 * classified (auth, authorization, validation).
 */
export function routeToGraph(route: ExpressRoute): IntermediateExecutionGraph {
  const nodes: ExecutionNode[] = route.middleware.map((mw, i) => ({
    id:     `mw_${i}`,
    type:   IR_NODE_TYPES.UNKNOWN_MIDDLEWARE,
    symbol: mw.text,
    file:   mw.file,
    line:   mw.line,
    ...(mw.args.length > 0 ? { args: mw.args } : {}),
    role:   "middleware",
  }))
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

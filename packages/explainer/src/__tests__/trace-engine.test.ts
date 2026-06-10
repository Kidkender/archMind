import type { IntermediateExecutionGraph } from "@archmind/protocol"
import { traceByPattern } from "../trace/trace-engine.js"

// Minimal fixture graphs for unit tests
const authGraph: IntermediateExecutionGraph = {
  entrypoint: "PUT /products/{product}",
  method: "PUT",
  path: "/products/{product}",
  framework: "laravel",
  adapter_ver: "0.1.0",
  ir_ver: "1.1",
  nodes: [
    { id: "mw_sanctum", type: "ir:auth_gate", symbol: "auth:sanctum" },
    { id: "ctrl_update", type: "ir:business_handler", symbol: "ProductController::update" },
    { id: "fr_update", type: "ir:validation_gate", symbol: "UpdateProductRequest::authorize" },
    { id: "res_product", type: "ir:resource", symbol: "Product", role: "accessed_resource" },
  ],
  edges: [
    { from: "mw_sanctum", to: "ctrl_update", relation: "next_middleware", traceability: "static" },
    { from: "ctrl_update", to: "fr_update", relation: "form_request", traceability: "static" },
    { from: "ctrl_update", to: "res_product", relation: "ir:accesses", traceability: "static" },
  ],
  annotations: [],
}

const noAuthGraph: IntermediateExecutionGraph = {
  entrypoint: "GET /products",
  method: "GET",
  path: "/products",
  framework: "laravel",
  adapter_ver: "0.1.0",
  ir_ver: "1.1",
  nodes: [
    { id: "ctrl_index", type: "ir:business_handler", symbol: "ProductController::index" },
  ],
  edges: [],
  annotations: [],
}

const txnGraph: IntermediateExecutionGraph = {
  entrypoint: "POST /orders",
  method: "POST",
  path: "/orders",
  framework: "laravel",
  adapter_ver: "0.1.0",
  ir_ver: "1.1",
  nodes: [
    { id: "mw_auth", type: "ir:auth_gate", symbol: "auth:sanctum" },
    { id: "ctrl_store", type: "ir:business_handler", symbol: "OrderController::store" },
    { id: "txn_1", type: "ir:txn_boundary", symbol: "DB::transaction" },
    { id: "write_1", type: "ir:txn_write", symbol: "Order::create" },
    { id: "escape_1", type: "ir:txn_escape", symbol: "OrderPlaced" },
  ],
  edges: [
    { from: "mw_auth", to: "ctrl_store", relation: "next_middleware", traceability: "static" },
    { from: "ctrl_store", to: "txn_1", relation: "ir:wraps", traceability: "static" },
    { from: "txn_1", to: "write_1", relation: "ir:calls", traceability: "static" },
    { from: "txn_1", to: "escape_1", relation: "ir:escapes", traceability: "static" },
  ],
  annotations: [],
}

const graphs = [authGraph, noAuthGraph, txnGraph]

// ---- trace-auth ------------------------------------------------------------

describe("traceByPattern('auth')", () => {
  const result = traceByPattern("auth", graphs)

  it("returns auth pattern", () => {
    expect(result.pattern).toBe("auth")
  })

  it("total_routes = all graphs", () => {
    expect(result.total_routes).toBe(3)
  })

  it("detects route with auth gateway", () => {
    const entry = result.results.find((r: { entrypoint: string }) => r.entrypoint === "PUT /products/{product}")
    expect(entry).toBeDefined()
    expect(entry.has_auth).toBe(true)
    expect(entry.auth_gates).toContain("auth:sanctum")
  })

  it("flags route without auth", () => {
    const entry = result.results.find((r: { entrypoint: string }) => r.entrypoint === "GET /products")
    expect(entry).toBeDefined()
    expect(entry.has_auth).toBe(false)
  })

  it("flags unprotected resource", () => {
    const entry = result.results.find((r: { entrypoint: string }) => r.entrypoint === "PUT /products/{product}")
    expect(entry.resources).toContain("Product")
    expect(entry.unprotected_resources).toContain("Product")
  })

  it("summary: routes_with_auth = 2", () => {
    expect(result.summary.routes_with_auth).toBe(2)
    expect(result.summary.routes_without_auth).toBe(1)
    expect(result.summary.routes_with_unprotected_resources).toBe(1)
  })
})

// ---- trace-event -----------------------------------------------------------

describe("traceByPattern('event')", () => {
  const result = traceByPattern("event", graphs)

  it("returns event pattern", () => {
    expect(result.pattern).toBe("event")
  })

  it("finds route with event dispatch", () => {
    expect(result.results).toHaveLength(1)
    expect(result.results[0].entrypoint).toBe("POST /orders")
    expect(result.results[0].dispatched_events).toContain("OrderPlaced")
    expect(result.results[0].inside_transaction).toBe(true)
  })

  it("summary: routes_with_unsafe_dispatch = 0 (dispatch is inside txn)", () => {
    expect(result.summary.routes_with_unsafe_dispatch).toBe(0)
  })
})

// ---- trace-transaction -----------------------------------------------------

describe("traceByPattern('transaction')", () => {
  const result = traceByPattern("transaction", graphs)

  it("finds route with transaction", () => {
    expect(result.results).toHaveLength(1)
    expect(result.results[0].boundaries).toContain("DB::transaction")
    expect(result.results[0].writes).toContain("Order::create")
    expect(result.results[0].escapes).toContain("OrderPlaced")
  })

  it("summary: routes_with_escapes = 1", () => {
    expect(result.summary.routes_with_escapes).toBe(1)
  })
})

// ---- trace-isolation -------------------------------------------------------

describe("traceByPattern('isolation')", () => {
  const isoGraph: IntermediateExecutionGraph = {
    entrypoint: "GET /tasks",
    method: "GET",
    path: "/tasks",
    framework: "laravel",
    adapter_ver: "0.1.0",
    ir_ver: "1.1",
    nodes: [
      { id: "ctrl_tasks", type: "ir:business_handler", symbol: "TaskController::index" },
      { id: "uq_1", type: "ir:unscoped_query", symbol: "Task::all" },
    ],
    edges: [],
    annotations: [],
  }

  const result = traceByPattern("isolation", [...graphs, isoGraph])

  it("finds route with unscoped query", () => {
    expect(result.results).toHaveLength(1)
    expect(result.results[0].unscoped_queries).toContain("Task::all")
    expect(result.results[0].has_tenant_context).toBe(false)
  })
})

// ---- trace-request ---------------------------------------------------------

describe("traceByPattern('request')", () => {
  const result = traceByPattern("request", graphs, "PUT /products/{product}")

  it("returns request pattern for given entrypoint", () => {
    expect(result.pattern).toBe("request")
    expect(result.results).toHaveLength(1)
  })

  it("execution_path starts with auth_gate", () => {
    const path = result.results[0].execution_path
    expect(path[0].symbol).toBe("auth:sanctum")
    expect(path[0].role).toBe("middleware")
  })

  it("execution_path includes all nodes", () => {
    const path = result.results[0].execution_path
    const symbols = path.map((p: { symbol: string }) => p.symbol)
    expect(symbols).toContain("ProductController::update")
    expect(symbols).toContain("UpdateProductRequest::authorize")
    expect(symbols).toContain("Product")
  })

  it("returns empty results for unknown entrypoint", () => {
    const r = traceByPattern("request", graphs, "GET /nonexistent")
    expect(r.results).toHaveLength(0)
  })
})

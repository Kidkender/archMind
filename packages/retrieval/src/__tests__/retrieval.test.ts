import { retrieve, prune, classifyNode } from "../retrieval-engine.js"
import type { IntermediateExecutionGraph } from "@archmind/protocol"

const AUTH_001_GRAPH: IntermediateExecutionGraph = {
  entrypoint: "PUT /tasks/{task}",
  method:     "PUT",
  path:       "/tasks/{task}",
  nodes: [
    { id: "mw_0", type: "authentication_gate", symbol: "auth:sanctum",           role: "authentication" },
    { id: "mw_1", type: "middleware",          symbol: "ResolveTenant",           role: "middleware" },
    { id: "mw_2", type: "authorization_check", symbol: "permission:task.update",  role: "authorization" },
    { id: "ctrl", type: "controller_action",   symbol: "TaskController::update",  role: "handler" },
  ],
  edges: [
    { from: "mw_0", to: "mw_1", relation: "next_middleware", traceability: "static" },
    { from: "mw_1", to: "mw_2", relation: "next_middleware", traceability: "static" },
    { from: "mw_2", to: "ctrl", relation: "next_middleware", traceability: "static" },
  ],
  annotations: [],
}

// ---- retrieve — happy path -------------------------------------------

describe("retrieve — PUT /tasks/{task}", () => {
  const result = retrieve({ entrypoint: "PUT /tasks/{task}" }, [AUTH_001_GRAPH])

  test("returns non-null result", () => {
    expect(result).not.toBeNull()
  })

  test("entrypoint matches", () => {
    expect(result!.entrypoint).toBe("PUT /tasks/{task}")
  })

  test("returns all nodes from matching graph", () => {
    expect(result!.nodes).toHaveLength(4)
  })

  test("returns all edges from matching graph", () => {
    expect(result!.edges).toHaveLength(3)
  })

  test("pruned is false at R0", () => {
    expect(result!.pruned).toBe(false)
  })

  test("token_estimate is a positive number", () => {
    expect(result!.token_estimate).toBeGreaterThan(0)
  })
})

// ---- retrieve — parameter name normalization -------------------------

describe("retrieve — parameter name normalization", () => {
  test("matches {task} entrypoint with {id} query", () => {
    const result = retrieve({ entrypoint: "PUT /tasks/{id}" }, [AUTH_001_GRAPH])
    expect(result).not.toBeNull()
  })

  test("returns null for wrong HTTP method", () => {
    const result = retrieve({ entrypoint: "GET /tasks/{task}" }, [AUTH_001_GRAPH])
    expect(result).toBeNull()
  })

  test("returns null for unrelated entrypoint", () => {
    const result = retrieve({ entrypoint: "DELETE /users/{id}" }, [AUTH_001_GRAPH])
    expect(result).toBeNull()
  })
})

// ---- prune — R1 relevance pruning -----------------------------------

const AUGMENTED_GRAPH: IntermediateExecutionGraph = {
  ...AUTH_001_GRAPH,
  nodes: [
    { id: "mw_0",   type: "authentication_gate", symbol: "auth:sanctum",                 role: "authentication" },
    { id: "mw_1",   type: "middleware",           symbol: "ResolveTenant",                role: "middleware" },
    { id: "mw_2",   type: "authorization_check",  symbol: "permission:task.update",       role: "authorization" },
    { id: "ctrl",   type: "controller_action",    symbol: "TaskController::update",       role: "handler" },
    { id: "fr",     type: "form_request",         symbol: "UpdateTaskRequest::authorize", role: "validation" },
    { id: "policy", type: "policy",               symbol: "TaskPolicy::update",           role: "authorization" },
  ],
}

describe("prune — HIGH threshold", () => {
  const r0     = retrieve({ entrypoint: "PUT /tasks/{task}" }, [AUGMENTED_GRAPH])!
  const pruned = prune(r0, "HIGH")

  test("pruned flag is true", () => {
    expect(pruned.pruned).toBe(true)
  })

  test("only HIGH-classified nodes are kept", () => {
    const types = pruned.nodes.map((n) => n.type)
    expect(types).toContain("authentication_gate")   // HIGH
    expect(types).toContain("authorization_check")   // HIGH
    expect(types).toContain("policy")                // HIGH
    expect(types).not.toContain("middleware")         // MEDIUM — pruned
    expect(types).not.toContain("form_request")       // MEDIUM — pruned
    expect(types).not.toContain("controller_action")  // MEDIUM — pruned
  })

  test("token_estimate is lower than R0", () => {
    expect(pruned.token_estimate).toBeLessThan(r0.token_estimate)
  })

  test("edges referencing pruned nodes are removed", () => {
    const keptIds = new Set(pruned.nodes.map((n) => n.id))
    for (const e of pruned.edges) {
      expect(keptIds.has(e.from)).toBe(true)
      expect(keptIds.has(e.to)).toBe(true)
    }
  })
})

describe("prune — MEDIUM threshold", () => {
  const r0     = retrieve({ entrypoint: "PUT /tasks/{task}" }, [AUGMENTED_GRAPH])!
  const pruned = prune(r0, "MEDIUM")

  test("MEDIUM and HIGH nodes are all kept", () => {
    expect(pruned.nodes).toHaveLength(6)
  })

  test("token_estimate is not larger than R0", () => {
    expect(pruned.token_estimate).toBeLessThanOrEqual(r0.token_estimate)
  })
})

describe("classifyNode", () => {
  test("policy → HIGH", () => {
    expect(classifyNode({ id: "x", type: "policy", symbol: "S", role: "r" })).toBe("HIGH")
  })
  test("form_request → MEDIUM", () => {
    expect(classifyNode({ id: "x", type: "form_request", symbol: "S", role: "r" })).toBe("MEDIUM")
  })
  test("unknown type → LOW", () => {
    expect(classifyNode({ id: "x", type: "unknown_type", symbol: "S", role: "r" })).toBe("LOW")
  })
})

// ---- retrieve — multiple graphs -------------------------------------

describe("retrieve — selects correct graph from multiple", () => {
  const DELETE_GRAPH: IntermediateExecutionGraph = {
    entrypoint: "DELETE /tasks/{task}",
    method: "DELETE",
    path: "/tasks/{task}",
    nodes: [{ id: "ctrl_delete", type: "controller_action", symbol: "TaskController::destroy", role: "handler" }],
    edges: [],
    annotations: [],
  }

  test("returns the matching graph when multiple graphs present", () => {
    const result = retrieve({ entrypoint: "DELETE /tasks/{task}" }, [AUTH_001_GRAPH, DELETE_GRAPH])
    expect(result!.nodes[0].symbol).toBe("TaskController::destroy")
  })
})

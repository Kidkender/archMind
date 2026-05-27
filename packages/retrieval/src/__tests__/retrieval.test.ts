import { retrieve, prune, classifyNode, deduplicate, rankByQuery } from "../retrieval-engine.js"
import type { IntermediateExecutionGraph, RetrievalResult } from "@archmind/protocol"
import { PROTOCOL_VERSION } from "@archmind/protocol"

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
    expect(types).toContain("form_request")          // HIGH (auth gate) — kept
    expect(types).not.toContain("middleware")         // MEDIUM — pruned
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
  test("form_request → HIGH", () => {
    expect(classifyNode({ id: "x", type: "form_request", symbol: "S", role: "r" })).toBe("HIGH")
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

// ---- deduplicate --------------------------------------------------------

const OBSIDIAN_STYLE_RESULT: RetrievalResult = {
  entrypoint: "POST /orders",
  nodes: [
    // Non-dedup types — must survive as distinct nodes
    { id: "svc_A_check_ctrl",   type: "service_call",        symbol: "IdempotencyService::check" },
    { id: "svc_A_check_mw",     type: "service_call",        symbol: "IdempotencyService::check" },
    { id: "policy_1",           type: "policy",              symbol: "OrderPolicy::create" },
    // Dedup targets — these should be merged
    { id: "txn_1",  type: "transaction_boundary", symbol: "DB::transaction" },
    { id: "txn_2",  type: "transaction_boundary", symbol: "DB::transaction" },
    { id: "txn_3",  type: "transaction_boundary", symbol: "DB::transaction" },
    { id: "txn_4",  type: "transaction_boundary", symbol: "DB::transaction" },
    { id: "uq_1",   type: "unscoped_query",       symbol: "IdempotencyKey::first" },
    { id: "uq_2",   type: "unscoped_query",       symbol: "IdempotencyKey::first" },
    { id: "uq_3",   type: "unscoped_query",       symbol: "IdempotencyKey::first" },
    { id: "uq_4",   type: "unscoped_query",       symbol: "IdempotencyKey::first" },
    { id: "uq_5",   type: "unscoped_query",       symbol: "IdempotencyKey::first" },
    { id: "uq_6",   type: "unscoped_query",       symbol: "IdempotencyKey::first" },
    { id: "uq_7",   type: "unscoped_query",       symbol: "IdempotencyKey::first" },
    { id: "uq_8",   type: "unscoped_query",       symbol: "IdempotencyKey::first" },
    { id: "uq_9",   type: "unscoped_query",       symbol: "IdempotencyKey::first" },
    { id: "uq_10",  type: "unscoped_query",       symbol: "IdempotencyKey::first" },
    // Different args — must NOT be merged with each other
    { id: "tw_a",   type: "transactional_write",  symbol: "Order::save", args: ["status=pending"] },
    { id: "tw_b",   type: "transactional_write",  symbol: "Order::save", args: ["status=confirmed"] },
  ],
  edges: [
    // Edges that should remap to canonical nodes
    { from: "txn_1", to: "uq_1",  relation: "transaction_wrap",  traceability: "static" },
    { from: "txn_2", to: "uq_5",  relation: "transaction_wrap",  traceability: "static" },
    { from: "txn_3", to: "tw_a",  relation: "writes",            traceability: "static" },
    // Edge between two non-dedup nodes — must pass through unchanged
    { from: "svc_A_check_ctrl", to: "policy_1", relation: "calls", traceability: "semantic" },
    // Duplicate edge that should be removed after remap
    { from: "txn_2", to: "uq_2",  relation: "transaction_wrap",  traceability: "static" },
  ],
  token_estimate: 1200,
  pruned:         false,
  focus:          "all",
  protocol_version: PROTOCOL_VERSION,
}

describe("deduplicate — type-aware graph deduplication", () => {
  let deduped: RetrievalResult

  beforeAll(() => {
    deduped = deduplicate(OBSIDIAN_STYLE_RESULT)
  })

  test("service_call nodes are NOT merged (caller-scoped invariant)", () => {
    const svcNodes = deduped.nodes.filter((n) => n.type === "service_call")
    expect(svcNodes).toHaveLength(2)
  })

  test("policy nodes are NOT merged", () => {
    const policyNodes = deduped.nodes.filter((n) => n.type === "policy")
    expect(policyNodes).toHaveLength(1)
  })

  test("transaction_boundary nodes with same symbol are merged to one", () => {
    const txnNodes = deduped.nodes.filter((n) => n.type === "transaction_boundary")
    expect(txnNodes).toHaveLength(1)
  })

  test("occurrenceCount reflects merged count for transaction_boundary", () => {
    const txnNode = deduped.nodes.find((n) => n.type === "transaction_boundary")!
    expect(txnNode.occurrenceCount).toBe(4)
  })

  test("unscoped_query ×10 merges to one node with occurrenceCount=10", () => {
    const uqNodes = deduped.nodes.filter((n) => n.type === "unscoped_query")
    expect(uqNodes).toHaveLength(1)
    expect(uqNodes[0].occurrenceCount).toBe(10)
  })

  test("transactional_write with different args are NOT merged", () => {
    const twNodes = deduped.nodes.filter((n) => n.type === "transactional_write")
    expect(twNodes).toHaveLength(2)
  })

  test("total node count is significantly reduced", () => {
    expect(deduped.nodes.length).toBeLessThan(OBSIDIAN_STYLE_RESULT.nodes.length)
    // 2 service_call + 1 policy + 1 txn_boundary + 1 unscoped_query + 2 transactional_write = 7
    expect(deduped.nodes.length).toBe(7)
  })

  test("edges remap to canonical node IDs and duplicates are removed", () => {
    const canonicalIds = new Set(deduped.nodes.map((n) => n.id))
    for (const e of deduped.edges) {
      expect(canonicalIds.has(e.from)).toBe(true)
      expect(canonicalIds.has(e.to)).toBe(true)
    }
  })

  test("duplicate edges after remap are removed", () => {
    // txn_1→uq_1 and txn_2→uq_5 both remap to canonical_txn→canonical_uq
    // only one should survive
    const txnToUq = deduped.edges.filter(
      (e) => e.relation === "transaction_wrap"
    )
    // Both edges had same canonical from/to after remap — deduped to 1
    const uniqueEdgeKeys = new Set(txnToUq.map((e) => `${e.from}|${e.to}|${e.relation}`))
    expect(uniqueEdgeKeys.size).toBe(txnToUq.length)
  })

  test("non-dedup node edges survive unchanged", () => {
    const callsEdge = deduped.edges.find((e) => e.relation === "calls")
    expect(callsEdge).toBeDefined()
    expect(callsEdge!.from).toBe("svc_A_check_ctrl")
    expect(callsEdge!.to).toBe("policy_1")
  })

  test("nodes without occurrenceCount set have it as undefined or 1", () => {
    const policyNode = deduped.nodes.find((n) => n.type === "policy")!
    expect(policyNode.occurrenceCount === undefined || policyNode.occurrenceCount === 1).toBe(true)
  })
})

// ---- rankByQuery --------------------------------------------------------

const RANK_GRAPH: RetrievalResult = {
  entrypoint: "POST /roles/assign",
  nodes: [
    { id: "ctrl",    type: "controller_action",   symbol: "RoleController::assign" },
    { id: "policy",  type: "policy",              symbol: "RolePolicy::update" },
    { id: "mw",      type: "middleware",           symbol: "ResolveTenant::handle" },
    { id: "svc",     type: "service_call",         symbol: "RoleService::validateRoleLevel" },
    { id: "perm",    type: "authorization_check",  symbol: "permission:role.assign" },
  ],
  edges: [],
  token_estimate: 300,
  pruned: false,
  focus: "all",
  protocol_version: PROTOCOL_VERSION,
}

describe("rankByQuery — keyword-based node ordering", () => {
  test("query with 'role' puts role-related nodes first", () => {
    const result = rankByQuery(RANK_GRAPH, "is the role level validation correct?")
    const symbols = result.nodes.map((n) => n.symbol)
    // RoleController, RolePolicy, RoleService all contain "role" → should lead
    const roleIdx = symbols.findIndex((s) => s.toLowerCase().includes("role"))
    const tenantIdx = symbols.findIndex((s) => s.includes("ResolveTenant"))
    expect(roleIdx).toBeLessThan(tenantIdx)
  })

  test("query with 'permission' puts permission node first", () => {
    const result = rankByQuery(RANK_GRAPH, "what permission check is here?")
    const first = result.nodes[0]
    expect(first.symbol.toLowerCase()).toContain("permission")
  })

  test("no query returns nodes in original order", () => {
    const result = rankByQuery(RANK_GRAPH, undefined)
    expect(result.nodes.map((n) => n.id)).toEqual(RANK_GRAPH.nodes.map((n) => n.id))
  })

  test("empty query returns nodes in original order", () => {
    const result = rankByQuery(RANK_GRAPH, "")
    expect(result.nodes.map((n) => n.id)).toEqual(RANK_GRAPH.nodes.map((n) => n.id))
  })

  test("structural (×N) nodes sort after non-structural", () => {
    const withDedup: RetrievalResult = {
      ...RANK_GRAPH,
      nodes: [
        { id: "txn", type: "transaction_boundary", symbol: "DB::transaction", occurrenceCount: 4 },
        ...RANK_GRAPH.nodes,
      ],
    }
    const result = rankByQuery(withDedup, "role permission check")
    const lastNode = result.nodes[result.nodes.length - 1]
    expect(lastNode.symbol).toBe("DB::transaction")
  })

  test("retrieve passes query through and produces sorted result", () => {
    const graph: IntermediateExecutionGraph = {
      entrypoint: "POST /roles/assign",
      method: "POST",
      path: "/roles/assign",
      nodes: RANK_GRAPH.nodes,
      edges: [],
      annotations: [],
    }
    const result = retrieve({ entrypoint: "POST /roles/assign", query: "role level validation" }, [graph])
    expect(result).not.toBeNull()
    const symbols = result!.nodes.map((n) => n.symbol)
    // All three role* symbols should appear before ResolveTenant
    const firstRoleIdx = symbols.findIndex((s) => s.toLowerCase().includes("role"))
    const tenantIdx    = symbols.findIndex((s) => s.includes("ResolveTenant"))
    expect(firstRoleIdx).toBeLessThan(tenantIdx)
  })
})

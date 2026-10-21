import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { explain } from "../index.js"

// A Go/Gin mutation route: authenticated, then a handler. Whether it is
// "authorized" depends on whether the parser saw an ownership check.

function ginGraph(withOwnership: boolean): IntermediateExecutionGraph {
  const nodes: IntermediateExecutionGraph["nodes"] = [
    { id: "mw_0", type: "ir:auth_gate", symbol: "middleware.AuthMiddleware(db)", role: "authentication" },
    { id: "handler", type: "ir:business_handler", symbol: "shopHandler.Buy", role: "handler" },
  ]
  if (withOwnership) {
    nodes.push({ id: "ownership", type: "ir:authz_check", symbol: "ownership:currentCharacter", role: "authorization" })
  }
  return {
    entrypoint: "POST /api/v1/shop/buy",
    method: "POST",
    path: "/api/v1/shop/buy",
    framework: "gin",
    adapter_ver: "0.1.0",
    ir_ver: "1.4",
    nodes,
    edges: [{ from: "mw_0", to: "handler", relation: "precedes", traceability: "static" }],
    annotations: [],
  } as IntermediateExecutionGraph
}

const types = (g: IntermediateExecutionGraph, opts?: Parameters<typeof explain>[2]) =>
  explain(g, undefined, opts).map((f) => f.type)

describe("explain — ownership authorization", () => {
  it("an authenticated mutation with no authorization is flagged", () => {
    expect(types(ginGraph(false))).toContain("missing_authorization")
  })

  it("the same route with an ownership authz_check is not flagged", () => {
    expect(types(ginGraph(true))).not.toContain("missing_authorization")
  })
})

describe("explain — ignore option", () => {
  it("drops the listed finding types", () => {
    expect(types(ginGraph(false), { ignore: ["missing_authorization"] })).not.toContain("missing_authorization")
  })

  it("keeps findings that are not listed", () => {
    const all = types(ginGraph(false))
    const kept = types(ginGraph(false), { ignore: ["fat_controller"] })
    expect(kept).toEqual(all)
  })

  it("an empty or absent list changes nothing", () => {
    expect(types(ginGraph(false), { ignore: [] })).toEqual(types(ginGraph(false)))
  })
})

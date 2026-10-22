import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { handlerRouteIndex } from "../routes.js"

function graph(entrypoint: string, handlerSymbol?: string): IntermediateExecutionGraph {
  return {
    entrypoint, method: entrypoint.split(" ")[0], path: entrypoint.split(" ")[1],
    framework: "go", adapter_ver: "0.1.0", ir_ver: "1.5",
    nodes: handlerSymbol ? [{ id: "h", type: "ir:business_handler", symbol: handlerSymbol }] : [],
    edges: [], annotations: [],
  }
}

describe("handlerRouteIndex", () => {
  it("maps a handler to its route, lower-cased so a variable name matches its type", () => {
    const idx = handlerRouteIndex([graph("GET /mail/:id", "mailHandler.Get")])
    expect(idx.get("mailhandler.get")).toEqual(["GET /mail/:id"])
  })

  it("collects every route one handler method serves", () => {
    const idx = handlerRouteIndex([graph("GET /a", "h.Do"), graph("GET /b", "h.Do")])
    expect(idx.get("h.do")).toEqual(["GET /a", "GET /b"])
  })

  it("skips routes without a handler node", () => {
    expect(handlerRouteIndex([graph("GET /health")]).size).toBe(0)
  })
})

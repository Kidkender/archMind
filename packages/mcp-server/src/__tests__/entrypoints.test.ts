import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { summarizeEntrypoints } from "../entrypoints.js"

function graph(method: string, path: string, handler?: { file: string; line: number }): IntermediateExecutionGraph {
  return {
    entrypoint: `${method} ${path}`,
    method,
    path,
    framework: "go",
    adapter_ver: "0.1.0",
    ir_ver: "1.5",
    nodes: [
      { id: "a", type: "ir:auth_gate", symbol: "auth" },
      { id: "h", type: "ir:business_handler", symbol: "h.Run", ...handler },
    ],
    edges: [],
    annotations: [],
  }
}

const graphs = [
  graph("POST", "/api/v1/inventory/use", { file: "internal/handler/inventory.go", line: 88 }),
  graph("GET", "/api/v1/character/sheet", { file: "internal/handler/character.go", line: 12 }),
  graph("GET", "/health"),
]

describe("summarizeEntrypoints", () => {
  it("returns the handler file and line for each route", () => {
    const [first] = summarizeEntrypoints(graphs)
    expect(first).toMatchObject({ entrypoint: "POST /api/v1/inventory/use", file: "internal/handler/inventory.go", line: 88 })
  })

  it("omits file and line when the handler node has none", () => {
    const health = summarizeEntrypoints(graphs).find((e) => e.path === "/health")!
    expect(health).not.toHaveProperty("file")
  })

  it("filters case-insensitively on entrypoint or handler file", () => {
    expect(summarizeEntrypoints(graphs, "INVENTORY").map((e) => e.path)).toEqual(["/api/v1/inventory/use"])
    expect(summarizeEntrypoints(graphs, "character.go").map((e) => e.path)).toEqual(["/api/v1/character/sheet"])
  })

  it("returns every route when the filter is empty or undefined", () => {
    expect(summarizeEntrypoints(graphs, "")).toHaveLength(3)
    expect(summarizeEntrypoints(graphs)).toHaveLength(3)
  })

  it("returns an empty array when nothing matches", () => {
    expect(summarizeEntrypoints(graphs, "zzz")).toEqual([])
  })
})

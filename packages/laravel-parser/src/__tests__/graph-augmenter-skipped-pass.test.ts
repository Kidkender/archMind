import { describe, test, expect, jest, beforeAll, afterAll } from "@jest/globals"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

// A graph pass inside a service method that throws is skipped and reported on
// stderr; the rest of the route's graph — earlier passes, later passes of the
// same service — still comes out. The isolation parser is made to throw for the
// service file only, so the controller-level passes run normally.

jest.unstable_mockModule("../isolation-parser.js", () => ({
  parseIsolation: (filePath: string) => {
    if (filePath.replace(/\\/g, "/").includes("app/Services/UserRepo.php")) throw new Error("boom in isolation")
    return { modelQueries: [], modelWrites: [], readsTenantFromContainer: false }
  },
}))

const { augmentGraph } = await import("../graph-augmenter.js")

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures")

const SKELETON: IntermediateExecutionGraph = {
  entrypoint: "DELETE /users/{user}",
  method: "DELETE", path: "/users/{user}",
  nodes: [{
    id: "ctrl_usercontroller_destroy", type: "ir:business_handler",
    symbol: "UserController::destroy", role: "handler",
    file: "app/Http/Controllers/UserController.php",
  }],
  edges:       [],
  annotations: [],
}

describe("augmentGraph — a pass that throws inside a service", () => {
  let warn: ReturnType<typeof jest.spyOn>
  let graph: IntermediateExecutionGraph

  beforeAll(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    graph = augmentGraph(SKELETON, { projectRoot: FIXTURES })
  })

  afterAll(() => warn.mockRestore())

  test("is reported with the pass, the file and the error", () => {
    const messages = warn.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(messages).toContainEqual(
      "[archmind] laravel-parser: isolation pass skipped for app/Services/UserRepo.php: boom in isolation",
    )
  })

  test("does not stop the rest of the graph: the service's calls and the transaction are still there", () => {
    expect(graph.nodes.some((n) => n.type === "ir:service_call" && n.symbol === "User::apiTokens()->delete")).toBe(true)
    expect(graph.nodes.some((n) => n.type === "ir:txn_boundary" && n.symbol === "DB::transaction")).toBe(true)
  })

  test("does not stop the later passes of the same service: its guard clause is still found", () => {
    expect(graph.nodes.find((n) => n.symbol === "UserRepo::ensureDeletable")?.type).toBe("ir:guard_clause")
  })
})

import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { augmentGraph } from "../graph-augmenter.js"
import type { IntermediateExecutionGraph } from "@archmind/protocol"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

const FIXTURES = join(__dirname, "fixtures")

// Skeleton graph where the controller node points at the fixture file
const SKELETON: IntermediateExecutionGraph = {
  entrypoint: "PUT /tasks/{task}",
  method:     "PUT",
  path:       "/tasks/{task}",
  nodes: [
    {
      id:     "ctrl_taskcontroller_update",
      type:   "controller_action",
      symbol: "TaskController::update",
      role:   "handler",
      file:   "app/Modules/Task/Http/Controllers/TaskController.php",
    },
  ],
  edges:       [],
  annotations: [],
}

describe("augmentGraph — TaskController::update", () => {
  let augmented: IntermediateExecutionGraph

  beforeAll(() => {
    augmented = augmentGraph(SKELETON, { projectRoot: FIXTURES })
  })

  test("adds a form_request node", () => {
    const types = augmented.nodes.map((n) => n.type)
    expect(types).toContain("form_request")
  })

  test("form_request symbol is UpdateTaskRequest::authorize", () => {
    const node = augmented.nodes.find((n) => n.type === "form_request")
    expect(node?.symbol).toBe("UpdateTaskRequest::authorize")
  })

  test("adds a policy node", () => {
    const types = augmented.nodes.map((n) => n.type)
    expect(types).toContain("policy")
  })

  test("policy symbol is TaskPolicy::update", () => {
    const node = augmented.nodes.find((n) => n.type === "policy")
    expect(node?.symbol).toBe("TaskPolicy::update")
  })

  test("form_request edge has traceability static", () => {
    const edge = augmented.edges.find((e) => e.relation === "form_request")
    expect(edge?.traceability).toBe("static")
    expect(edge?.from).toBe("ctrl_taskcontroller_update")
  })

  test("policy_check edge has traceability semantic", () => {
    const edge = augmented.edges.find((e) => e.relation === "policy_check")
    expect(edge?.traceability).toBe("semantic")
    expect(edge?.from).toBe("ctrl_taskcontroller_update")
    expect(edge?.mechanism).toMatch(/authorize/)
  })

  test("original skeleton nodes are preserved", () => {
    expect(augmented.nodes.some((n) => n.type === "controller_action")).toBe(true)
  })
})

describe("augmentGraph — missing file field", () => {
  test("returns graph unchanged when controller has no file field", () => {
    const noFile: IntermediateExecutionGraph = {
      ...SKELETON,
      nodes: [{ id: "ctrl", type: "controller_action", symbol: "Ctrl::act", role: "handler" }],
    }
    const result = augmentGraph(noFile, { projectRoot: FIXTURES })
    expect(result.nodes).toHaveLength(1)
    expect(result.edges).toHaveLength(0)
  })
})

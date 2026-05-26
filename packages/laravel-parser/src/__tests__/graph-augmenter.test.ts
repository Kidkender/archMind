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

describe("augmentGraph — service_call extraction", () => {
  let augmented: IntermediateExecutionGraph

  const SKELETON_WITH_MW: IntermediateExecutionGraph = {
    entrypoint: "PUT /tasks/{task}",
    method: "PUT", path: "/tasks/{task}",
    nodes: [
      {
        id: "mw_2_checkpermission", type: "authorization_check",
        symbol: "CheckPermission::handle", role: "authorization",
        file: "app/Http/Middleware/CheckPermission.php",
      },
      {
        id: "ctrl_taskcontroller_update", type: "controller_action",
        symbol: "TaskController::update", role: "handler",
        file: "app/Modules/Task/Http/Controllers/TaskController.php",
      },
    ],
    edges: [
      { from: "mw_2_checkpermission", to: "ctrl_taskcontroller_update", relation: "next_middleware", traceability: "static" },
    ],
    annotations: [],
  }

  beforeAll(() => {
    augmented = augmentGraph(SKELETON_WITH_MW, { projectRoot: FIXTURES })
  })

  test("extracts service_call from CheckPermission::handle", () => {
    const sc = augmented.nodes.find(
      n => n.type === "service_call" && n.symbol === "PermissionService::hasPermission"
        && n.id.includes("checkpermission")
    )
    expect(sc).toBeDefined()
  })

  test("CheckPermission service_call has correct file", () => {
    const sc = augmented.nodes.find(
      n => n.type === "service_call" && n.id.includes("checkpermission")
    )
    expect(sc?.file).toBe("app/Modules/Access/Services/PermissionService.php")
  })

  test("extracts service_call from TaskPolicy::update", () => {
    const sc = augmented.nodes.find(
      n => n.type === "service_call" && n.symbol === "PermissionService::hasPermission"
        && n.id.includes("policy")
    )
    expect(sc).toBeDefined()
  })

  test("policy service_call has args (TASK_UPDATE)", () => {
    const sc = augmented.nodes.find(
      n => n.type === "service_call" && n.id.includes("policy")
    )
    expect(sc?.args).toContain("TASK_UPDATE")
  })

  test("service_call edges have relation 'calls' and traceability semantic", () => {
    const serviceCallIds = new Set(augmented.nodes.filter(n => n.type === "service_call").map(n => n.id))
    const scEdges = augmented.edges.filter(e => e.relation === "calls" && serviceCallIds.has(e.to))
    expect(scEdges.length).toBeGreaterThanOrEqual(2)
    expect(scEdges.every(e => e.traceability === "semantic")).toBe(true)
  })

  test("two distinct service_call nodes for same method (caller-scoped IDs)", () => {
    const scNodes = augmented.nodes.filter(
      n => n.type === "service_call" && n.symbol === "PermissionService::hasPermission"
    )
    expect(scNodes.length).toBe(2)
    expect(scNodes[0].id).not.toBe(scNodes[1].id)
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

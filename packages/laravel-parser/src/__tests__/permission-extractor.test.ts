import { describe, test, expect } from "@jest/globals"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { parseConstantClass } from "../constant-resolver.js"
import { extractPermissionNodes } from "../permission-extractor/constants.js"
import { buildHierarchyEdges } from "../permission-extractor/hierarchy.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PERM_FIXTURE   = resolve(__dirname, "fixtures/Permission.php")
const PERMS_FIXTURE  = resolve(__dirname, "fixtures/Permissions.php")
const REL_PATH       = "app/Common/Constants/Permission.php"

// ── extractPermissionNodes ───────────────────────────────────────────────────

describe("extractPermissionNodes", () => {
  test("emits one permission node per constant", () => {
    const map = parseConstantClass(PERM_FIXTURE)
    const nodes = extractPermissionNodes(map, REL_PATH)
    expect(nodes).toHaveLength(4) // TASK_VIEW, TASK_UPDATE, TASK_DELETE, TASK_DELETE_ANY
  })

  test("node type is always 'permission'", () => {
    const nodes = extractPermissionNodes(parseConstantClass(PERM_FIXTURE), REL_PATH)
    expect(nodes.every((n) => n.type === "ir:permission_constant")).toBe(true)
  })

  test("symbol is ClassName::CONST_NAME", () => {
    const nodes = extractPermissionNodes(parseConstantClass(PERM_FIXTURE), REL_PATH)
    const symbols = nodes.map((n) => n.symbol)
    expect(symbols).toContain("Permission::TASK_DELETE")
    expect(symbols).toContain("Permission::TASK_DELETE_ANY")
    expect(symbols).toContain("Permission::TASK_VIEW")
    expect(symbols).toContain("Permission::TASK_UPDATE")
  })

  test("node file matches relativeFilePath", () => {
    const nodes = extractPermissionNodes(parseConstantClass(PERM_FIXTURE), REL_PATH)
    expect(nodes.every((n) => n.file === REL_PATH)).toBe(true)
  })

  test("node ids are unique", () => {
    const nodes = extractPermissionNodes(parseConstantClass(PERM_FIXTURE), REL_PATH)
    const ids = nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// ── buildHierarchyEdges ──────────────────────────────────────────────────────

describe("buildHierarchyEdges", () => {
  test("creates one privilege_hierarchy edge for _ANY pair", () => {
    const nodes = extractPermissionNodes(parseConstantClass(PERM_FIXTURE), REL_PATH)
    const edges = buildHierarchyEdges(nodes)
    expect(edges).toHaveLength(1)
    expect(edges[0].relation).toBe("privilege_hierarchy")
  })

  test("edge goes from elevated (_ANY) to basic", () => {
    const nodes = extractPermissionNodes(parseConstantClass(PERM_FIXTURE), REL_PATH)
    const edges = buildHierarchyEdges(nodes)
    const edge = edges[0]
    const elevatedNode = nodes.find((n) => n.symbol === "Permission::TASK_DELETE_ANY")!
    const basicNode    = nodes.find((n) => n.symbol === "Permission::TASK_DELETE")!
    expect(edge.from).toBe(elevatedNode.id)
    expect(edge.to).toBe(basicNode.id)
  })

  test("traceability is static", () => {
    const nodes = extractPermissionNodes(parseConstantClass(PERM_FIXTURE), REL_PATH)
    const edges = buildHierarchyEdges(nodes)
    expect(edges[0].traceability).toBe("static")
  })

  test("no hierarchy edges when no _ANY pairs present", () => {
    const nodes = extractPermissionNodes(parseConstantClass(PERMS_FIXTURE), "app/Constants/Permissions.php")
    const edges = buildHierarchyEdges(nodes)
    expect(edges).toHaveLength(0)
  })

  test("no hierarchy edge when _ANY has no base counterpart", () => {
    // Synthetic case: only TASK_DELETE_ANY, no TASK_DELETE
    const nodes = [
      { id: "perm_p_task_delete_any", type: "ir:permission_constant", symbol: "P::TASK_DELETE_ANY" },
    ]
    const edges = buildHierarchyEdges(nodes)
    expect(edges).toHaveLength(0)
  })
})

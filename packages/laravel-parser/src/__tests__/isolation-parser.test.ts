import { describe, test, expect } from "@jest/globals"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { parseIsolation } from "../isolation-parser.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE   = resolve(__dirname, "fixtures/TaskShowController.php")

describe("parseIsolation", () => {
  test("detects tenant container read (app('tenant'))", () => {
    const result = parseIsolation(FIXTURE)
    expect(result.readsTenantFromContainer).toBe(true)
  })

  test("finds Task::find as unscoped query", () => {
    const result  = parseIsolation(FIXTURE)
    const unscoped = result.modelQueries.filter(
      (q) => q.model === "Task" && q.operation === "find" && !q.hastenantConstraint
    )
    expect(unscoped.length).toBeGreaterThanOrEqual(1)
  })

  test("Task::where('tenant_id',...)->findOrFail is marked as scoped", () => {
    const result = parseIsolation(FIXTURE)
    const scoped = result.modelQueries.filter(
      (q) => q.model === "Task" && q.hastenantConstraint
    )
    expect(scoped.length).toBeGreaterThanOrEqual(1)
  })

  test("Task::whereTenantId()->find() is marked as scoped", () => {
    const result = parseIsolation(FIXTURE)
    const scoped = result.modelQueries.filter(
      (q) => q.model === "Task" && q.hastenantConstraint && q.operation === "find"
    )
    // showByTenant uses whereTenantId — should be scoped
    expect(scoped.length).toBeGreaterThanOrEqual(1)
  })

  test("returns empty result for non-PHP file (no crash)", () => {
    const result = parseIsolation("/nonexistent/file.php")
    expect(result.modelQueries).toHaveLength(0)
    expect(result.readsTenantFromContainer).toBe(false)
  })

  test("Permission.php has no model queries and no tenant reads", () => {
    const result = parseIsolation(resolve(__dirname, "fixtures/Permission.php"))
    expect(result.readsTenantFromContainer).toBe(false)
    expect(result.modelQueries).toHaveLength(0)
  })
})

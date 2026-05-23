import { describe, test, expect } from "@jest/globals"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { parseTransactions } from "../transaction-parser.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE   = resolve(__dirname, "fixtures/TaskController.php")

describe("parseTransactions", () => {
  test("detects transactions in file", () => {
    const result = parseTransactions(FIXTURE)
    expect(result.hasTransaction).toBe(true)
  })

  test("finds 3 transaction blocks (store, update, destroy)", () => {
    const result = parseTransactions(FIXTURE)
    expect(result.blocks).toHaveLength(3)
  })

  test("store block detects TaskCreated::dispatch as event escape", () => {
    const result  = parseTransactions(FIXTURE)
    const store   = result.blocks[0]!
    expect(store.dispatches).toHaveLength(1)
    expect(store.dispatches[0]!.className).toBe("TaskCreated")
    expect(store.dispatches[0]!.kind).toBe("event")
  })

  test("store block detects Task::create as transactional write", () => {
    const result = parseTransactions(FIXTURE)
    const store  = result.blocks[0]!
    const taskCreate = store.writes.find((w) => w.className === "Task")
    expect(taskCreate).toBeDefined()
    expect(taskCreate!.operation).toBe("create")
  })

  test("update block has no dispatches (safe pattern)", () => {
    const result  = parseTransactions(FIXTURE)
    const update  = result.blocks[1]!
    expect(update.dispatches).toHaveLength(0)
  })

  test("update block detects instance write (task->update)", () => {
    const result = parseTransactions(FIXTURE)
    const update = result.blocks[1]!
    expect(update.writes.some((w) => w.operation === "update")).toBe(true)
  })

  test("destroy block detects ProcessTaskReport::dispatch as job escape", () => {
    const result   = parseTransactions(FIXTURE)
    const destroy  = result.blocks[2]!
    expect(destroy.dispatches).toHaveLength(1)
    expect(destroy.dispatches[0]!.className).toBe("ProcessTaskReport")
    expect(destroy.dispatches[0]!.kind).toBe("job")
  })

  test("destroy block detects task->delete as transactional write", () => {
    const result  = parseTransactions(FIXTURE)
    const destroy = result.blocks[2]!
    expect(destroy.writes.some((w) => w.operation === "delete")).toBe(true)
  })

  test("returns no blocks for file without transactions", () => {
    const result = parseTransactions(resolve(__dirname, "fixtures/Permission.php"))
    expect(result.hasTransaction).toBe(false)
    expect(result.blocks).toHaveLength(0)
  })

  test("returns empty result for nonexistent file", () => {
    const result = parseTransactions("/nonexistent/file.php")
    expect(result.hasTransaction).toBe(false)
    expect(result.blocks).toHaveLength(0)
  })
})

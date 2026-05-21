import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { readFileSync } from "fs"
import { parseControllerMethod, extractUseMap } from "../controller-parser.js"
import Parser from "tree-sitter"
// @ts-ignore
import PHP from "tree-sitter-php"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

const FIXTURES = join(__dirname, "fixtures")
const TASK_CTRL = join(FIXTURES, "app/Modules/Task/Http/Controllers/TaskController.php")

// ---- parseControllerMethod -----------------------------------------------

describe("parseControllerMethod — TaskController::update", () => {
  let result: ReturnType<typeof parseControllerMethod>

  beforeAll(() => {
    result = parseControllerMethod(TASK_CTRL, "update")
  })

  test("returns non-null result", () => {
    expect(result).not.toBeNull()
  })

  test("extracts UpdateTaskRequest from method signature", () => {
    expect(result!.formRequests).toHaveLength(1)
    expect(result!.formRequests[0].shortName).toBe("UpdateTaskRequest")
  })

  test("resolves UpdateTaskRequest to FQCN via use map", () => {
    expect(result!.formRequests[0].fqcn).toBe(
      "App\\Modules\\Task\\Requests\\UpdateTaskRequest"
    )
  })

  test("captures param name", () => {
    expect(result!.formRequests[0].paramName).toBe("$request")
  })

  test("does not include untyped $id parameter as FormRequest", () => {
    const names = result!.formRequests.map((fr) => fr.shortName)
    expect(names).not.toContain("int")
    expect(names).not.toContain("$id")
    expect(names).toHaveLength(1)
  })

  test("extracts one authorize() call", () => {
    expect(result!.authorizeCalls).toHaveLength(1)
  })

  test("authorize() ability is 'update'", () => {
    expect(result!.authorizeCalls[0].ability).toBe("update")
  })

  test("authorize() mechanism text includes '$this->authorize'", () => {
    expect(result!.authorizeCalls[0].mechanism).toMatch(/\$this->authorize/)
  })
})

describe("parseControllerMethod — TaskController::index (viewAny)", () => {
  test("extracts viewAny authorize call", () => {
    const result = parseControllerMethod(TASK_CTRL, "index")
    expect(result).not.toBeNull()
    expect(result!.authorizeCalls).toHaveLength(1)
    expect(result!.authorizeCalls[0].ability).toBe("viewAny")
  })

  test("no FormRequest in index method", () => {
    const result = parseControllerMethod(TASK_CTRL, "index")
    expect(result!.formRequests).toHaveLength(0)
  })
})

describe("parseControllerMethod — non-existent method", () => {
  test("returns empty L1 for missing method", () => {
    const result = parseControllerMethod(TASK_CTRL, "nonexistent")
    expect(result).not.toBeNull()
    expect(result!.formRequests).toHaveLength(0)
    expect(result!.authorizeCalls).toHaveLength(0)
  })
})

describe("parseControllerMethod — file not found", () => {
  test("returns null for missing file", () => {
    const result = parseControllerMethod("/nonexistent/path/Controller.php", "update")
    expect(result).toBeNull()
  })
})

// ---- extractUseMap -------------------------------------------------------

describe("extractUseMap from controller file", () => {
  let useMap: Map<string, string>

  beforeAll(() => {
    const parser = new Parser()
    parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)
    const src  = readFileSync(TASK_CTRL, "utf-8")
    const tree = parser.parse(src)
    useMap = extractUseMap(tree.rootNode)
  })

  test("maps UpdateTaskRequest to its FQCN", () => {
    expect(useMap.get("UpdateTaskRequest")).toBe(
      "App\\Modules\\Task\\Requests\\UpdateTaskRequest"
    )
  })

  test("maps TaskService to its FQCN", () => {
    expect(useMap.get("TaskService")).toBe(
      "App\\Modules\\Task\\Services\\TaskService"
    )
  })
})

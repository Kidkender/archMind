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

// ---- P0: Constructor middleware extraction ---------------------------------

const MW_CTRL = join(FIXTURES, "app/Http/Controllers/MiddlewareController.php")

describe("parseControllerMethod — constructor middleware (P0)", () => {
  test("extracts $this->middleware() with except filter", () => {
    const result = parseControllerMethod(MW_CTRL, "protectedAction")
    expect(result).not.toBeNull()
    expect(result!.constructorMiddleware).toHaveLength(2)
    expect(result!.constructorMiddleware[0].raw).toBe("auth:web,subdealer")
    expect(result!.constructorMiddleware[0].except).toEqual(["publicAction", "anotherPublic"])
    expect(result!.constructorMiddleware[0].only).toEqual([])
  })

  test("extracts second middleware with no filters", () => {
    const result = parseControllerMethod(MW_CTRL, "protectedAction")
    expect(result!.constructorMiddleware[1].raw).toBe("verified")
    expect(result!.constructorMiddleware[1].except).toEqual([])
    expect(result!.constructorMiddleware[1].only).toEqual([])
  })

  test("returns empty constructorMiddleware when no __construct", () => {
    const result = parseControllerMethod(TASK_CTRL, "update")
    expect(result).not.toBeNull()
    expect(result!.constructorMiddleware).toHaveLength(0)
  })

  test("constructorMiddleware still returned when method not found", () => {
    const result = parseControllerMethod(MW_CTRL, "nonexistent")
    expect(result).not.toBeNull()
    expect(result!.constructorMiddleware).toHaveLength(2)
  })
})

// ---- Phase 5C: private method traversal (depth 1) -----------------------

const ROLE_CTRL = join(FIXTURES, "app/Modules/Role/Http/Controllers/RoleController.php")

describe("parseControllerMethod — private method traversal (depth 1)", () => {
  let result: ReturnType<typeof parseControllerMethod>

  beforeAll(() => {
    result = parseControllerMethod(ROLE_CTRL, "assign")
  })

  test("returns non-null result", () => {
    expect(result).not.toBeNull()
  })

  test("extracts authorize() from public method body", () => {
    expect(result!.authorizeCalls.some((a) => a.ability === "assign")).toBe(true)
  })

  test("extracts service call from private helper validateRequestedRoleLevel", () => {
    const svcSymbols = result!.serviceCalls.map((sc) => sc.serviceClass + "::" + sc.method)
    expect(svcSymbols).toContain("PermissionService::checkRoleHierarchy")
  })

  test("extracts service call from public method body (roleService.assignRole)", () => {
    const svcSymbols = result!.serviceCalls.map((sc) => sc.serviceClass + "::" + sc.method)
    expect(svcSymbols).toContain("RoleService::assignRole")
  })

  test("does NOT traverse into ensureNotSelfAssign (not called from assign)", () => {
    const svcSymbols = result!.serviceCalls.map((sc) => sc.method)
    expect(svcSymbols).not.toContain("assertNotSelf")
    expect(svcSymbols).not.toContain("lockForAssign")
  })

  test("service calls are deduplicated (no double-counting from depth-1)", () => {
    const keys = result!.serviceCalls.map((sc) => `${sc.propertyName}::${sc.method}`)
    const unique = new Set(keys)
    expect(keys.length).toBe(unique.size)
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

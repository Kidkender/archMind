import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { extractRoutes } from "../extractors/route.extractor.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FIXTURES   = join(__dirname, "fixtures")

describe("extractRoutes — UserController", () => {
  let routes: ReturnType<typeof extractRoutes>

  beforeAll(() => {
    routes = extractRoutes({ projectRoot: FIXTURES })
  })

  test("extracts 6 routes", () => {
    expect(routes).toHaveLength(6)
  })

  test("GET /users/health is @Public (no guards)", () => {
    const r = routes.find(r => r.path === "/users/health")
    expect(r).toBeDefined()
    expect(r!.isPublic).toBe(true)
    expect(r!.guards).toHaveLength(0)
  })

  test("GET /users inherits JwtAuthGuard from controller", () => {
    const r = routes.find(r => r.method === "GET" && r.path === "/users")
    expect(r).toBeDefined()
    expect(r!.guards[0].className).toBe("JwtAuthGuard")
    expect(r!.guards[0].irType).toBe("ir:auth_gate")
  })

  test("POST /users has controller JwtAuthGuard + method RolesGuard with admin arg", () => {
    const r = routes.find(r => r.method === "POST" && r.path === "/users")
    expect(r!.guards).toHaveLength(2)
    expect(r!.guards[0].irType).toBe("ir:auth_gate")
    expect(r!.guards[1].irType).toBe("ir:authz_check")
    expect(r!.guards[1].args).toEqual(["admin"])
  })

  test("DELETE /users/:id has 3 guards (controller + 2 from @UseGuards(A,B))", () => {
    const r = routes.find(r => r.method === "DELETE")
    expect(r!.guards).toHaveLength(3)
    expect(r!.guards[2].args).toEqual(["admin", "superadmin"])
  })

  test("PUT /users/:id has dto=UpdateUserDto and validationPipe=true", () => {
    const r = routes.find(r => r.method === "PUT")
    expect(r!.dto).toBe("UpdateUserDto")
    expect(r!.validationPipe).toBe(true)
  })

  test("POST /users has dto=CreateUserDto", () => {
    const r = routes.find(r => r.method === "POST" && r.path === "/users")
    expect(r!.dto).toBe("CreateUserDto")
  })

  test("symbol is ControllerClass::methodName", () => {
    const r = routes.find(r => r.method === "POST" && r.path === "/users")
    expect(r!.symbol).toBe("UserController::create")
  })
})

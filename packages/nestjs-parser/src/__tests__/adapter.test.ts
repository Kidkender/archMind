import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { parseNestJSProject } from "../adapter.js"

const __filename = fileURLToPath(import.meta.url)
const GLOBAL_GUARD_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "global-guard")
const __dirname  = dirname(__filename)
const FIXTURES   = join(__dirname, "fixtures", "user-api")

describe("parseNestJSProject — full pipeline", () => {
  let graphs: ReturnType<typeof parseNestJSProject>

  beforeAll(() => {
    graphs = parseNestJSProject(FIXTURES)
  })

  test("emits 6 graphs", () => {
    expect(graphs).toHaveLength(6)
  })

  test("each graph has framework=nestjs and ir_ver set", () => {
    for (const g of graphs) {
      expect(g.framework).toBe("nestjs")
      expect(g.ir_ver).toBeDefined()
    }
  })

  test("@Public() health route has no nodes except business_handler", () => {
    const g = graphs.find(g => g.path === "/users/health")!
    const types = g.nodes.map(n => n.type)
    expect(types).toEqual(["ir:business_handler"])
    expect(g.edges).toHaveLength(0)
  })

  test("GET /users has auth_gate + handler", () => {
    const g = graphs.find(g => g.method === "GET" && g.path === "/users")!
    const types = g.nodes.map(n => n.type)
    expect(types).toContain("ir:auth_gate")
    expect(types).toContain("ir:business_handler")
  })

  test("POST /users has auth_gate + authz_check + handler (no validation — no global pipe)", () => {
    const g = graphs.find(g => g.method === "POST" && g.path === "/users")!
    const types = g.nodes.map(n => n.type)
    expect(types).toContain("ir:auth_gate")
    expect(types).toContain("ir:authz_check")
    expect(types).toContain("ir:business_handler")
    // No ValidationPipe active (neither local nor global)
    expect(types).not.toContain("ir:validation_gate")
  })

  test("PUT /users/:id has validation_gate (local @UsePipes)", () => {
    const g = graphs.find(g => g.method === "PUT")!
    const types = g.nodes.map(n => n.type)
    expect(types).toContain("ir:validation_gate")
  })

  test("guard chain edges exist for POST /users", () => {
    const g = graphs.find(g => g.method === "POST" && g.path === "/users")!
    const nextMwEdges = g.edges.filter(e => e.relation === "next_middleware")
    expect(nextMwEdges.length).toBeGreaterThanOrEqual(2)
  })
})

describe("parseNestJSProject — APP_GUARD global guards", () => {
  let graphs: ReturnType<typeof parseNestJSProject>

  beforeAll(() => {
    graphs = parseNestJSProject(GLOBAL_GUARD_FIXTURES)
  })

  test("emits 4 graphs from posts controller", () => {
    expect(graphs).toHaveLength(4)
  })

  test("non-public routes get global JwtAuthGuard prepended", () => {
    const g = graphs.find(g => g.method === "GET" && g.path === "/posts")!
    const authGates = g.nodes.filter(n => n.type === "ir:auth_gate")
    expect(authGates).toHaveLength(1)
    expect(authGates[0].symbol).toBe("JwtAuthGuard")
  })

  test("@Public() route has no guard nodes", () => {
    const g = graphs.find(g => g.path === "/posts/public-stats")!
    expect(g.nodes.filter(n => n.type === "ir:auth_gate")).toHaveLength(0)
    expect(g.nodes.filter(n => n.type === "ir:authz_check")).toHaveLength(0)
  })

  test("@Public() route has only business_handler node", () => {
    const g = graphs.find(g => g.path === "/posts/public-stats")!
    expect(g.nodes.map(n => n.type)).toEqual(["ir:business_handler"])
  })

  test("global guard node has authentication role", () => {
    const g = graphs.find(g => g.method === "POST" && g.path === "/posts")!
    const gateNode = g.nodes.find(n => n.type === "ir:auth_gate")!
    expect(gateNode.role).toBe("authentication")
  })
})

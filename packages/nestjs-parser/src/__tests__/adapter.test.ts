import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { parseNestJSProject } from "../adapter.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FIXTURES   = join(__dirname, "fixtures")

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

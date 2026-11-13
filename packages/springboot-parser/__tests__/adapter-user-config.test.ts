import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import { parseSpringBootProject } from "../src/adapter.js"

const CONTROLLER = `
  package com.example.web;
  import org.springframework.web.bind.annotation.*;

  @RestController
  @RequestMapping("/api/orders")
  public class OrderController {
    @RequireLogin
    @GetMapping
    public String list() { return "ok"; }

    @RequiresRoles("admin")
    @DeleteMapping("/{id}")
    public void remove(@PathVariable Long id) { }

    @TeamOnly
    @PostMapping
    public void create(@RequestBody String body) { }
  }
`

function nodeTypes(graphs: ReturnType<typeof parseSpringBootProject>, method: string): string[] {
  const g = graphs.find((x) => x.method === method)
  if (!g) throw new Error(`no graph for ${method}`)
  return g.nodes.map((n) => n.type)
}

describe("parseSpringBootProject — archmind.json guards", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "archmind-sb-config-"))
    writeFileSync(join(dir, "OrderController.java"), CONTROLLER)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("without archmind.json, known-but-unclassified annotations stay ir:unknown_middleware", () => {
    const graphs = parseSpringBootProject(dir)

    expect(nodeTypes(graphs, "GET")).toContain(IR_NODE_TYPES.UNKNOWN_MIDDLEWARE)
    expect(nodeTypes(graphs, "DELETE")).toContain(IR_NODE_TYPES.UNKNOWN_MIDDLEWARE)
    // @TeamOnly is not a recognised name at all
    expect(nodeTypes(graphs, "POST")).not.toContain(IR_NODE_TYPES.AUTH_GATE)
    expect(nodeTypes(graphs, "POST")).not.toContain(IR_NODE_TYPES.UNKNOWN_MIDDLEWARE)
  })

  test("guards.auth_gate and guards.authz_check classify the project's own annotations", () => {
    writeFileSync(join(dir, "archmind.json"), JSON.stringify({
      guards: { auth_gate: ["RequireLogin"], authz_check: ["RequiresRoles", "TeamOnly"] },
    }))

    const graphs = parseSpringBootProject(dir)

    const get = nodeTypes(graphs, "GET")
    expect(get).toContain(IR_NODE_TYPES.AUTH_GATE)
    expect(get).not.toContain(IR_NODE_TYPES.AUTHZ_CHECK)
    expect(get).not.toContain(IR_NODE_TYPES.UNKNOWN_MIDDLEWARE)

    const del = nodeTypes(graphs, "DELETE")
    expect(del).toContain(IR_NODE_TYPES.AUTH_GATE)
    expect(del).toContain(IR_NODE_TYPES.AUTHZ_CHECK)
    expect(del).not.toContain(IR_NODE_TYPES.UNKNOWN_MIDDLEWARE)

    const post = nodeTypes(graphs, "POST")
    expect(post).toContain(IR_NODE_TYPES.AUTH_GATE)
    expect(post).toContain(IR_NODE_TYPES.AUTHZ_CHECK)

    const authz = graphs.find((g) => g.method === "DELETE")!.nodes
      .find((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)!
    expect(authz.symbol).toBe(`@RequiresRoles(admin)`)
  })

  test("a malformed archmind.json is ignored", () => {
    writeFileSync(join(dir, "archmind.json"), "{ not json")

    const graphs = parseSpringBootProject(dir)

    expect(nodeTypes(graphs, "GET")).toContain(IR_NODE_TYPES.UNKNOWN_MIDDLEWARE)
  })
})

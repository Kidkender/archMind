/**
 * IR v2 Conformance Tests — NestJS Parser
 *
 * Ensures the NestJS adapter emits only known IR node types and edge relations.
 * Unknown types/relations are failures; legacy strings are tracked as migration
 * debt via snapshots.
 */
import { join } from "path"
import { parseNestJSProject } from "../adapter.js"
import { validateGraph } from "@kidkender/archmind-protocol"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const FIXTURES_USER_API     = join(process.cwd(), "src/__tests__/fixtures/user-api")
const FIXTURES_SIDE_EFFECTS = join(process.cwd(), "src/__tests__/fixtures/side-effects")
const FIXTURES_GLOBAL_GUARD = join(process.cwd(), "src/__tests__/fixtures/global-guard")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function allGraphViolations(graphs: IntermediateExecutionGraph[]) {
  return graphs.flatMap((g) => {
    const { violations } = validateGraph(g)
    return violations.map((v) => ({ route: g.entrypoint, ...v }))
  })
}

function unknownOnly(violations: ReturnType<typeof allGraphViolations>) {
  return violations.filter(
    (v) => v.kind === "unknown_node_type" || v.kind === "unknown_edge_relation"
  )
}

// ---------------------------------------------------------------------------
// Suite 1: User API fixture (standard CRUD)
// ---------------------------------------------------------------------------

describe("IR conformance — NestJS user-api fixture", () => {
  let graphs: IntermediateExecutionGraph[]

  beforeAll(() => {
    graphs = parseNestJSProject(FIXTURES_USER_API)
  })

  test("parser produces graphs", () => {
    expect(graphs.length).toBeGreaterThan(0)
  })

  test("no unknown node types or edge relations", () => {
    const unknown = unknownOnly(allGraphViolations(graphs))
    if (unknown.length > 0) {
      const summary = unknown
        .map((v) => `  [${v.route}] ${v.kind}: "${v.value}"`)
        .join("\n")
      throw new Error(`Unknown IR types in NestJS output — add to protocol:\n${summary}`)
    }
    expect(unknown).toHaveLength(0)
  })

  test("tracks legacy node types (snapshot — should shrink over time)", () => {
    const legacyTypeSet = new Set(
      allGraphViolations(graphs)
        .filter((v) => v.kind === "legacy_node_type")
        .map((v) => v.value)
    )
    expect([...legacyTypeSet].sort()).toMatchSnapshot()
  })

  test("tracks legacy edge relations (snapshot — should shrink over time)", () => {
    const legacyRelSet = new Set(
      allGraphViolations(graphs)
        .filter((v) => v.kind === "legacy_edge_relation")
        .map((v) => v.value)
    )
    expect([...legacyRelSet].sort()).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// Suite 2: Side-effects fixture (queue + events)
// ---------------------------------------------------------------------------

describe("IR conformance — NestJS side-effects fixture", () => {
  let graphs: IntermediateExecutionGraph[]

  beforeAll(() => {
    graphs = parseNestJSProject(FIXTURES_SIDE_EFFECTS)
  })

  test("no unknown node types or edge relations", () => {
    const unknown = unknownOnly(allGraphViolations(graphs))
    if (unknown.length > 0) {
      const summary = unknown
        .map((v) => `  [${v.route}] ${v.kind}: "${v.value}"`)
        .join("\n")
      throw new Error(`Unknown IR types in NestJS side-effects:\n${summary}`)
    }
    expect(unknown).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Suite 3: Global guard fixture (auth coverage)
// ---------------------------------------------------------------------------

describe("IR conformance — NestJS global-guard fixture", () => {
  let graphs: IntermediateExecutionGraph[]

  beforeAll(() => {
    graphs = parseNestJSProject(FIXTURES_GLOBAL_GUARD)
  })

  test("no unknown node types or edge relations", () => {
    const unknown = unknownOnly(allGraphViolations(graphs))
    if (unknown.length > 0) {
      const summary = unknown
        .map((v) => `  [${v.route}] ${v.kind}: "${v.value}"`)
        .join("\n")
      throw new Error(`Unknown IR types in NestJS global-guard:\n${summary}`)
    }
    expect(unknown).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Suite 4: Transaction fixture (txn boundary + writes)
// None of the fixtures above opens a transaction, which is how a non-IR edge
// relation between a transaction and its writes went unnoticed.
// ---------------------------------------------------------------------------

describe("IR conformance — NestJS transaction fixture", () => {
  let graphs: IntermediateExecutionGraph[]

  beforeAll(() => {
    graphs = parseNestJSProject(join(process.cwd(), "../../research/cross-framework/auth-transaction/nestjs"))
  })

  test("the fixture opens a transaction with writes", () => {
    const types = graphs.flatMap((g) => g.nodes.map((n) => n.type))
    expect(types).toContain("ir:txn_boundary")
    expect(types).toContain("ir:txn_write")
  })

  test("no unknown node types or edge relations", () => {
    expect(unknownOnly(allGraphViolations(graphs))).toEqual([])
  })

  test("writes hang off the transaction by ir:wraps", () => {
    const [g] = graphs
    const txn = g.nodes.find((n) => n.type === "ir:txn_boundary")!
    const writes = g.nodes.filter((n) => n.type === "ir:txn_write")
    for (const w of writes) {
      expect(g.edges).toContainEqual(expect.objectContaining({ from: txn.id, to: w.id, relation: "ir:wraps" }))
    }
  })
})

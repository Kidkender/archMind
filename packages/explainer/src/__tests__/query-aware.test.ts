import { describe, test, expect } from "@jest/globals"
import { classifyQuery } from "../query/classify.js"
import { prioritizeByFocus } from "../query/prioritize.js"
import { FINDING_TYPES } from "../findings/types.js"
import type { Finding } from "../findings/types.js"

function makeFinding(id: string, type: string): Finding {
  return {
    id,
    type,
    severity: "INFO",
    confidence: "LOW",
    provenance: { detector: "test", ontology_primitives: [], supporting_nodes: [], supporting_edges: [] },
    summary: "test",
    reasoning: [],
    evidence: [],
  }
}

// ── classifyQuery ────────────────────────────────────────────────────────────

describe("classifyQuery", () => {
  test.each([
    ["auth", "auth"],
    ["authorization", "auth"],
    ["permission check", "auth"],
    ["policy gate", "auth"],
    ["guard middleware", "auth"],
    ["access control", "auth"],
    ["role assignment", "auth"],
    ["privilege escalation", "auth"],
  ])('"%s" → focus: %s', (query, focus) => {
    expect(classifyQuery(query).focus).toBe(focus)
  })

  test.each([
    ["validation rules", "validation"],
    ["validate the input", "validation"],
    ["FormRequest handling", "validation"],
    ["form request class", "validation"],
  ])('"%s" → focus: %s', (query, focus) => {
    expect(classifyQuery(query).focus).toBe(focus)
  })

  test.each([
    ["runtime injection", "runtime"],
    ["inject service", "runtime"],
    ["container binding", "runtime"],
  ])('"%s" → focus: %s', (query, focus) => {
    expect(classifyQuery(query).focus).toBe(focus)
  })

  test.each([
    ["how does routing work", "all"],
    ["list all findings", "all"],
    ["explain the graph", "all"],
    ["", "all"],
    ["   ", "all"],
  ])('"%s" → focus: all', (query) => {
    expect(classifyQuery(query).focus).toBe("all")
  })

  test("preserves raw query", () => {
    const q = "check my permission"
    expect(classifyQuery(q).raw).toBe(q)
  })

  test("authorization request → auth (not validation)", () => {
    // "authorization request" contains auth keyword — must resolve as auth, not validation
    expect(classifyQuery("authorization request").focus).toBe("auth")
  })
})

// ── prioritizeByFocus ────────────────────────────────────────────────────────

describe("prioritizeByFocus", () => {
  const authFinding = makeFinding("a1", FINDING_TYPES.DUPLICATE_AUTHORIZATION)
  const authFinding2 = makeFinding("a2", FINDING_TYPES.MISSING_AUTHORIZATION)
  const authFinding3 = makeFinding("a3", FINDING_TYPES.PRIVILEGE_HIERARCHY_PRESENT)
  const validationFinding = makeFinding("v1", FINDING_TYPES.DELEGATED_VALIDATION)
  const runtimeFinding = makeFinding("r1", FINDING_TYPES.HIDDEN_RUNTIME_DEPENDENCY)

  test("focus=all returns findings unchanged", () => {
    const findings = [authFinding, validationFinding, runtimeFinding]
    expect(prioritizeByFocus(findings, "all")).toEqual(findings)
  })

  test("focus=auth puts auth findings first", () => {
    const findings = [runtimeFinding, validationFinding, authFinding]
    const result = prioritizeByFocus(findings, "auth")
    expect(result[0].type).toBe(FINDING_TYPES.DUPLICATE_AUTHORIZATION)
    expect(result).toHaveLength(3)
  })

  test("focus=validation puts delegated_validation first", () => {
    const findings = [runtimeFinding, authFinding, validationFinding]
    const result = prioritizeByFocus(findings, "validation")
    expect(result[0].type).toBe(FINDING_TYPES.DELEGATED_VALIDATION)
  })

  test("focus=runtime puts hidden_runtime_dependency first", () => {
    const findings = [authFinding, validationFinding, runtimeFinding]
    const result = prioritizeByFocus(findings, "runtime")
    expect(result[0].type).toBe(FINDING_TYPES.HIDDEN_RUNTIME_DEPENDENCY)
  })

  test("focus=auth zero auth findings → returns all in original order", () => {
    const findings = [runtimeFinding, validationFinding]
    const result = prioritizeByFocus(findings, "auth")
    expect(result).toEqual(findings)
  })

  test("empty findings list → empty result", () => {
    expect(prioritizeByFocus([], "auth")).toEqual([])
  })

  test("all three auth finding types promoted", () => {
    const findings = [runtimeFinding, authFinding3, authFinding2, authFinding, validationFinding]
    const result = prioritizeByFocus(findings, "auth")
    const primaryTypes = result.slice(0, 3).map(f => f.type)
    expect(primaryTypes).toContain(FINDING_TYPES.DUPLICATE_AUTHORIZATION)
    expect(primaryTypes).toContain(FINDING_TYPES.MISSING_AUTHORIZATION)
    expect(primaryTypes).toContain(FINDING_TYPES.PRIVILEGE_HIERARCHY_PRESENT)
  })

  test("stable: primary group preserves original rank order", () => {
    // auth findings in a specific order — that order must be preserved in primary group
    const findings = [authFinding2, authFinding, authFinding3, runtimeFinding]
    const result = prioritizeByFocus(findings, "auth")
    const primaryIds = result.slice(0, 3).map(f => f.id)
    expect(primaryIds).toEqual(["a2", "a1", "a3"])
  })

  test("stable: secondary group preserves original rank order", () => {
    const findings = [authFinding, runtimeFinding, validationFinding]
    const result = prioritizeByFocus(findings, "auth")
    const secondaryIds = result.slice(1).map(f => f.id)
    expect(secondaryIds).toEqual(["r1", "v1"])
  })
})

// ── drift guard ──────────────────────────────────────────────────────────────

describe("FINDING_TYPES drift guard", () => {
  const MAPPED_TYPES = new Set([
    FINDING_TYPES.DUPLICATE_AUTHORIZATION,
    FINDING_TYPES.MISSING_AUTHORIZATION,
    FINDING_TYPES.MISSING_POLICY,
    FINDING_TYPES.PRIVILEGE_HIERARCHY_PRESENT,
    FINDING_TYPES.DELEGATED_VALIDATION,
    FINDING_TYPES.HIDDEN_RUNTIME_DEPENDENCY,
    FINDING_TYPES.EVENT_BEFORE_COMMIT,
    FINDING_TYPES.MISSING_TENANT_SCOPE,
    FINDING_TYPES.DOUBLE_PERMISSION_CHECK,
    FINDING_TYPES.RUNTIME_CONSUMER_TRACE,
  ])

  test("every FINDING_TYPES value is covered in the focus map", () => {
    for (const value of Object.values(FINDING_TYPES)) {
      expect(MAPPED_TYPES.has(value)).toBe(true)
    }
  })
})

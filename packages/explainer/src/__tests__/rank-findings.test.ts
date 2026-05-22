import { describe, test, expect } from "@jest/globals"
import { rankFindings } from "../ranking/rank-findings.js"
import type { Finding } from "../findings/types.js"

function makeFinding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    id: overrides.id,
    type: overrides.type ?? "test_type",
    severity: overrides.severity ?? "INFO",
    confidence: overrides.confidence ?? "LOW",
    provenance: overrides.provenance ?? {
      detector: "test",
      ontology_primitives: [],
      supporting_nodes: [],
      supporting_edges: [],
    },
    summary: overrides.summary ?? "test summary",
    reasoning: overrides.reasoning ?? [],
    evidence: overrides.evidence ?? [],
    uncertainty: overrides.uncertainty,
    recommendations: overrides.recommendations,
  }
}

describe("rankFindings", () => {
  test("higher severity ranks first", () => {
    const findings = [
      makeFinding({ id: "a", severity: "LOW" }),
      makeFinding({ id: "b", severity: "HIGH" }),
      makeFinding({ id: "c", severity: "MEDIUM" }),
    ]
    const ranked = rankFindings(findings)
    expect(ranked.map((f) => f.id)).toEqual(["b", "c", "a"])
  })

  test("same severity: higher confidence ranks first", () => {
    const findings = [
      makeFinding({ id: "a", severity: "MEDIUM", confidence: "LOW" }),
      makeFinding({ id: "b", severity: "MEDIUM", confidence: "HIGH" }),
      makeFinding({ id: "c", severity: "MEDIUM", confidence: "MEDIUM" }),
    ]
    const ranked = rankFindings(findings)
    expect(ranked.map((f) => f.id)).toEqual(["b", "c", "a"])
  })

  test("same severity+confidence: more supporting nodes ranks first", () => {
    const mkProvenance = (nodes: string[]) => ({
      detector: "test",
      ontology_primitives: [],
      supporting_nodes: nodes,
      supporting_edges: [],
    })
    const findings = [
      makeFinding({ id: "a", severity: "HIGH", confidence: "HIGH", provenance: mkProvenance(["x"]) }),
      makeFinding({ id: "b", severity: "HIGH", confidence: "HIGH", provenance: mkProvenance(["x", "y", "z"]) }),
      makeFinding({ id: "c", severity: "HIGH", confidence: "HIGH", provenance: mkProvenance(["x", "y"]) }),
    ]
    const ranked = rankFindings(findings)
    expect(ranked.map((f) => f.id)).toEqual(["b", "c", "a"])
  })

  test("same severity+confidence+nodes: more recommendations ranks first", () => {
    const findings = [
      makeFinding({ id: "a", severity: "INFO", confidence: "LOW" }),
      makeFinding({ id: "b", severity: "INFO", confidence: "LOW", recommendations: ["fix it", "also this"] }),
      makeFinding({ id: "c", severity: "INFO", confidence: "LOW", recommendations: ["fix it"] }),
    ]
    const ranked = rankFindings(findings)
    expect(ranked.map((f) => f.id)).toEqual(["b", "c", "a"])
  })

  test("all equal: alphabetical id as tiebreaker", () => {
    const findings = [
      makeFinding({ id: "gamma" }),
      makeFinding({ id: "alpha" }),
      makeFinding({ id: "beta" }),
    ]
    const ranked = rankFindings(findings)
    expect(ranked.map((f) => f.id)).toEqual(["alpha", "beta", "gamma"])
  })

  test("does not mutate input array", () => {
    const findings = [
      makeFinding({ id: "b", severity: "LOW" }),
      makeFinding({ id: "a", severity: "HIGH" }),
    ]
    const original = [...findings]
    rankFindings(findings)
    expect(findings.map((f) => f.id)).toEqual(original.map((f) => f.id))
  })

  test("returns empty array for empty input", () => {
    expect(rankFindings([])).toEqual([])
  })

  test("single finding is returned unchanged", () => {
    const findings = [makeFinding({ id: "only", severity: "CRITICAL", confidence: "HIGH" })]
    expect(rankFindings(findings)).toEqual(findings)
  })

  test("CRITICAL severity ranks above all others", () => {
    const findings = [
      makeFinding({ id: "a", severity: "HIGH" }),
      makeFinding({ id: "b", severity: "CRITICAL" }),
      makeFinding({ id: "c", severity: "MEDIUM" }),
    ]
    const ranked = rankFindings(findings)
    expect(ranked[0]!.id).toBe("b")
  })
})

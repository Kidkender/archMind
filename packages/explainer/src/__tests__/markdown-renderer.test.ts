import { describe, test, expect } from "@jest/globals"
import { renderMarkdown } from "../renderers/markdown.js"
import type { Finding } from "../findings/types.js"

const sampleFinding: Finding = {
  id: "duplicate_authorization-abcd1234",
  type: "duplicate_authorization",
  severity: "LOW",
  confidence: "HIGH",
  provenance: {
    detector: "duplicate_authorization",
    ontology_primitives: ["AuthorizationCheck", "ExecutionOverlap"],
    supporting_nodes: ["check_permission", "task_policy_update"],
    supporting_edges: [],
  },
  summary: 'Permission "update" is checked in 2 layers: middleware, policy',
  reasoning: [
    { type: "authorization_check", node: "check_permission", ability: "update", layer: "middleware" },
    { type: "authorization_check", node: "task_policy_update", ability: "update", layer: "policy" },
    { type: "execution_overlap_detected", layers: ["middleware", "policy"], ability: "update" },
  ],
  evidence: [
    { nodeId: "check_permission", description: 'middleware layer checks permission for "update"', detail: "task.update" },
    { nodeId: "task_policy_update", description: 'policy layer checks permission for "update"' },
  ],
  recommendations: ['Consider consolidating "update" authorization to a single layer'],
}

describe("renderMarkdown", () => {
  test("returns no-findings message for empty array", () => {
    const output = renderMarkdown([])
    expect(output).toContain("No findings detected")
  })

  test("includes finding count", () => {
    const output = renderMarkdown([sampleFinding])
    expect(output).toContain("1 finding(s)")
  })

  test("includes finding type heading", () => {
    const output = renderMarkdown([sampleFinding])
    expect(output).toContain("DUPLICATE AUTHORIZATION")
  })

  test("includes severity badge", () => {
    const output = renderMarkdown([sampleFinding])
    expect(output).toContain("LOW")
  })

  test("includes summary", () => {
    const output = renderMarkdown([sampleFinding])
    expect(output).toContain('Permission "update" is checked in 2 layers')
  })

  test("includes evidence section", () => {
    const output = renderMarkdown([sampleFinding])
    expect(output).toContain("Evidence")
    expect(output).toContain("check_permission")
  })

  test("includes reasoning section", () => {
    const output = renderMarkdown([sampleFinding])
    expect(output).toContain("Reasoning")
    expect(output).toContain("execution_overlap_detected")
  })

  test("includes recommendations", () => {
    const output = renderMarkdown([sampleFinding])
    expect(output).toContain("Recommendations")
    expect(output).toContain("consolidating")
  })

  test("uncertainty section omitted when empty", () => {
    const output = renderMarkdown([sampleFinding])
    expect(output).not.toContain("Uncertainty")
  })

  test("uncertainty section shown when present", () => {
    const withUncertainty: Finding = {
      ...sampleFinding,
      uncertainty: [{ kind: "low_fact_confidence", nodeId: "x", description: "tenant equivalence inferred semantically" }],
    }
    const output = renderMarkdown([withUncertainty])
    expect(output).toContain("Uncertainty")
    expect(output).toContain("tenant equivalence inferred semantically")
  })
})

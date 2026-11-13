/**
 * Cross-framework equivalence: the same security pattern written in Laravel,
 * NestJS and Express produces the same set of semantic IR node types.
 * Fixtures live in research/cross-framework/{pattern}/{laravel,nestjs,express}/.
 *
 * Not covered for Express (outside the parser's scope): auth-side-effects
 * (events, queues), auth-api-resource (response shaping), cron-transaction.
 */
import { describe, test, expect } from "@jest/globals"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { parseRouteFile, augmentGraph, inferProjectConfig, resolveAliasMap } from "@kidkender/archmind-laravel-parser"
import { parseNestJSProject } from "@kidkender/archmind-nestjs-parser"
import { validateGraph } from "@kidkender/archmind-protocol"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { parseExpressProjectAt } from "../adapter.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, "../../../../research/cross-framework")

/** Node types that carry the security / data semantics compared across frameworks. */
const SEMANTIC_TYPES = new Set([
  "ir:auth_gate", "ir:authz_check", "ir:validation_gate", "ir:business_handler",
  "ir:service_call", "ir:txn_boundary", "ir:txn_write",
])

function semanticTypes(graphs: IntermediateExecutionGraph[], only: ReadonlySet<string> = SEMANTIC_TYPES): string[] {
  expect(graphs).toHaveLength(1)
  return [...new Set(graphs[0].nodes.map((n) => n.type).filter((t) => only.has(t)))].sort()
}

/**
 * The types a pattern is about: the security layers always (a missing or extra
 * one must show), plus the pattern's own concern. Incidental calls outside it —
 * the Laravel auth-authz fixture also updates the model, which Laravel reports
 * as a service call — are not part of the comparison.
 */
function comparedTypes(expected: string[]): Set<string> {
  return new Set(["ir:auth_gate", "ir:authz_check", "ir:validation_gate", "ir:business_handler", ...expected])
}

function laravel(pattern: string): IntermediateExecutionGraph[] {
  const root = join(FIXTURES, pattern, "laravel")
  const config = inferProjectConfig(root)
  const aliasMap = resolveAliasMap(root, config) as unknown as Record<string, string>
  return parseRouteFile(join(root, "routes/api.php"), { aliasMap }).map((g) => augmentGraph(g, { projectRoot: root, config }))
}

const nestjs = (pattern: string) => parseNestJSProject(join(FIXTURES, pattern, "nestjs"))
const express = (pattern: string) => parseExpressProjectAt(join(FIXTURES, pattern, "express"))

const PATTERNS: { pattern: string; expected: string[] }[] = [
  { pattern: "auth-only",         expected: ["ir:auth_gate", "ir:business_handler"] },
  { pattern: "auth-authz",        expected: ["ir:auth_gate", "ir:authz_check", "ir:business_handler"] },
  { pattern: "auth-validation",   expected: ["ir:auth_gate", "ir:business_handler", "ir:validation_gate"] },
  { pattern: "auth-service-call", expected: ["ir:auth_gate", "ir:business_handler", "ir:service_call"] },
  { pattern: "auth-transaction",  expected: ["ir:auth_gate", "ir:business_handler", "ir:txn_boundary", "ir:txn_write"] },
]

describe.each(PATTERNS)("cross-framework: $pattern", ({ pattern, expected }) => {
  test("Express emits the expected semantic node types", () => {
    expect(semanticTypes(express(pattern))).toEqual(expected)
  })

  test("Express matches NestJS", () => {
    const only = comparedTypes(expected)
    expect(semanticTypes(express(pattern), only)).toEqual(semanticTypes(nestjs(pattern), only))
  })

  test("Express matches Laravel", () => {
    const only = comparedTypes(expected)
    expect(semanticTypes(express(pattern), only)).toEqual(semanticTypes(laravel(pattern), only))
  })

  test("Express graphs use only IR node types and edge relations", () => {
    for (const g of express(pattern)) {
      const unknown = validateGraph(g).violations.filter(
        (v) => v.kind === "unknown_node_type" || v.kind === "unknown_edge_relation",
      )
      expect(unknown).toEqual([])
    }
  })
})

test("transaction writes name their entities, as NestJS does", () => {
  const [g] = express("auth-transaction")
  const writes = g.nodes.filter((n) => n.type === "ir:txn_write").map((n) => n.symbol)
  expect(writes).toEqual(["Order::save", "Payment::save"])
  const [ng] = nestjs("auth-transaction")
  expect(ng.nodes.filter((n) => n.type === "ir:txn_write").map((n) => n.symbol).sort()).toEqual(writes)
})

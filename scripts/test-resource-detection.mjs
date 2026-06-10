/**
 * Smoke test: verify RESOURCE_UNPROTECTED fires for PUT /products/{product}
 * Usage: node scripts/test-resource-detection.mjs
 */

import { join } from "path"
import { fileURLToPath } from "url"
import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap } from "../packages/laravel-parser/dist/index.js"
import { extractFacts, detect } from "../packages/explainer/dist/index.js"

const PROJECT_ROOT = "C:/Users/Admin/Desktop/DuckCode/New folder/laravel/ecomerce-api"
const TARGET = "PUT /products/{product}"

console.log(`\n=== ArchMind RESOURCE Detection Smoke Test ===`)
console.log(`Project: ${PROJECT_ROOT}`)
console.log(`Target:  ${TARGET}\n`)

// Parse project
const config = loadProjectConfig(PROJECT_ROOT)
const { aliasMap, routeFiles } = resolveAliasMap(PROJECT_ROOT, config)

const allGraphs = []
for (const relFile of routeFiles) {
  const skeletons = parseRouteFile(join(PROJECT_ROOT, relFile), { aliasMap })
  for (const g of skeletons) {
    allGraphs.push(augmentGraph(g, { projectRoot: PROJECT_ROOT, config }))
  }
}

console.log(`Parsed ${allGraphs.length} graphs total`)

const graph = allGraphs.find((g) =>
  g.entrypoint?.toLowerCase().includes("products/{product}") &&
  g.entrypoint?.toLowerCase().startsWith("put")
)

if (!graph) {
  console.error(`\nERROR: Route "${TARGET}" not found.`)
  console.log(`Available routes:`)
  allGraphs.forEach((g) => console.log(`  ${g.entrypoint}`))
  process.exit(1)
}

console.log(`\n[GRAPH] ${graph.entrypoint}`)
console.log(`  adapter_ver: ${graph.adapter_ver ?? "n/a"}`)
console.log(`  ir_ver:      ${graph.ir_ver ?? "n/a"}`)
console.log(`  nodes:       ${graph.nodes.length}`)
console.log(`  edges:       ${graph.edges.length}`)

console.log(`\n[ALL NODES]`)
for (const n of graph.nodes) {
  console.log(`  ${n.id.padEnd(52)} type=${n.type}`)
}

const resourceNodes = graph.nodes.filter((n) => n.type === "ir:resource")
const accessesEdges = graph.edges.filter((e) => e.relation === "ir:accesses")
const authorizesEdges = graph.edges.filter((e) => e.relation === "ir:authorizes")

console.log(`\n[ir:resource NODES]  ${resourceNodes.length}`)
resourceNodes.forEach((n) => console.log(`  ${n.id}  symbol=${n.symbol}  role=${n.role}`))

console.log(`\n[ir:accesses EDGES]  ${accessesEdges.length}`)
accessesEdges.forEach((e) => console.log(`  ${e.from} → ${e.to}`))

console.log(`\n[ir:authorizes EDGES]  ${authorizesEdges.length}`)
authorizesEdges.forEach((e) => console.log(`  ${e.from} → ${e.to}`))

// Run detectors
const facts = extractFacts(graph)
const findings = detect(facts, graph)
console.log(`\n[FINDINGS]  ${findings.length} total`)
findings.forEach((f) => {
  const mark = f.type === "resource_unprotected" ? " ← TARGET" : ""
  console.log(`  [${f.severity}] ${f.type}${mark}`)
})

// Assertions
let pass = true
const check = (label, cond) => {
  if (cond) { console.log(`\nPASS  ${label}`) }
  else { console.error(`\nFAIL  ${label}`); pass = false }
}

check("ir:resource node emitted for Product", resourceNodes.some((n) => n.symbol === "Product"))
check("ir:accesses edge from controller to resource", accessesEdges.length > 0)
check("No ir:authorizes edge (correct — no authorize() call)", authorizesEdges.length === 0)
check("RESOURCE_UNPROTECTED finding fires", findings.some((f) => f.type === "resource_unprotected"))

const unprotected = findings.find((f) => f.type === "resource_unprotected")
if (unprotected) check("RESOURCE_UNPROTECTED severity is CRITICAL", unprotected.severity === "CRITICAL")

console.log(`\n${ pass ? "✓ ALL CHECKS PASSED" : "✗ SOME CHECKS FAILED" }\n`)
process.exit(pass ? 0 : 1)

/**
 * NestJS adapter recall benchmark.
 * Scores the adapter output against golden traces for real projects.
 * Projects must exist on disk — skipped automatically if missing.
 */
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { existsSync, readFileSync } from "fs"
import yaml from "js-yaml"
import { parseNestJSProject } from "../adapter.js"

const __dirname  = dirname(fileURLToPath(import.meta.url))
// __dirname = .../archMind/packages/nestjs-parser/src/__tests__
// 4 levels up = archMind/
const TRACES_ROOT = join(__dirname, "../../../../research/golden-traces")

interface GoldenNode { id: string; type: string; symbol: string; retrieval: { relevance: string } }
interface GoldenTrace { id: string; entrypoint: string; nodes: GoldenNode[] }

function loadTrace(filePath: string): GoldenTrace {
  return yaml.load(readFileSync(filePath, "utf8")) as GoldenTrace
}

function normalizeEp(ep: string) {
  return ep.replace(/\{[^}]+\}/g, "{*}")
}

function scoreRecall(trace: GoldenTrace, graphs: ReturnType<typeof parseNestJSProject>): number {
  const graph = graphs.find(g => normalizeEp(g.entrypoint) === normalizeEp(trace.entrypoint))
  if (!graph) return 0

  const highNodes = trace.nodes.filter(n => n.retrieval.relevance === "HIGH")
  if (!highNodes.length) return 1

  let matched = 0
  for (const golden of highNodes) {
    const hit = graph.nodes.find(n =>
      n.symbol.toLowerCase().includes(golden.symbol.toLowerCase()) ||
      golden.symbol.toLowerCase().includes(n.symbol.toLowerCase())
    )
    if (hit) matched++
  }
  return matched / highNodes.length
}

const CASES = [
  {
    traceFile:    join(TRACES_ROOT, "nestjs-ipfs/NESTJS-AUTH-001.yaml"),
    projectRoot:  "C:/Users/Admin/Desktop/DuckCode/Backend/IPFS-api",
    expectedRecall: 1.0,
  },
  {
    traceFile:    join(TRACES_ROOT, "nestjs-ipfs/NESTJS-FILE-001.yaml"),
    projectRoot:  "C:/Users/Admin/Desktop/DuckCode/Backend/IPFS-api",
    expectedRecall: 1.0,
  },
  {
    traceFile:    join(TRACES_ROOT, "nestjs-education/NESTJS-GLOBAL-GUARD-001.yaml"),
    projectRoot:  "C:/Users/Admin/Desktop/DuckCode/Node/education-api",
    expectedRecall: 1.0,
  },
]

describe("NestJS adapter — golden trace recall", () => {
  const results: { id: string; recall: number }[] = []

  afterAll(() => {
    console.log("\n  NestJS Adapter Recall")
    console.log("  " + "─".repeat(50))
    for (const r of results) {
      const icon = r.recall >= 1.0 ? "✓" : "✗"
      console.log(`  ${icon} ${r.id.padEnd(36)} recall=${r.recall.toFixed(2)}`)
    }
    const avg = results.length
      ? results.reduce((s, r) => s + r.recall, 0) / results.length
      : 0
    console.log(`  ${"─".repeat(50)}`)
    console.log(`    Avg recall: ${avg.toFixed(2)}  (${results.length} traces)`)
  })

  for (const { traceFile, projectRoot, expectedRecall } of CASES) {
    // Load trace lazily inside test to avoid failing at module level
    test(`${traceFile.split("/").pop()?.replace(".yaml", "")} recall >= ${expectedRecall}`, () => {
      if (!existsSync(projectRoot)) {
        console.log(`    SKIP — project not found: ${projectRoot}`)
        return
      }

      const trace   = loadTrace(traceFile)
      const graphs  = parseNestJSProject(projectRoot)
      const recall  = scoreRecall(trace, graphs)
      results.push({ id: trace.id, recall })

      expect(recall).toBeGreaterThanOrEqual(expectedRecall)
    })
  }
})

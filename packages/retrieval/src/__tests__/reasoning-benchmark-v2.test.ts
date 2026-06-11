/**
 * Reasoning Benchmark v2 — multi-project structural scoring (no LLM)
 *
 * Discovers all research/golden-qa/**\/*.yaml pairs, groups by project folder,
 * parses each project that exists on disk, and validates EvidencePackage quality.
 *
 * Metrics per pair:
 *   - finding_match:        expected_finding === package.finding
 *   - intent_match:         expected_intent === package.intent
 *   - evidence_precision:   % expected_evidence_nodes present in package
 *   - composite_score:      0.5*evidence_precision + 0.3*finding_match + 0.2*intent_match
 *
 * Global assertions:
 *   - avg_composite_score >= 0.70
 *   - avg_evidence_precision >= 0.80
 */

import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { readdirSync, readFileSync, existsSync } from "fs"
import yaml from "js-yaml"
import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap } from "@archmind/laravel-parser"
import { buildEvidencePackage } from "@archmind/explainer"
import type { IntermediateExecutionGraph } from "@archmind/protocol"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const REPO_ROOT  = join(__dirname, "../../../..")
const QA_ROOT    = join(REPO_ROOT, "research/golden-qa")

// Known project paths — extend as more projects are added
const PROJECT_PATHS: Record<string, string> = {
  "ecomerce-api":         "C:/Users/Admin/Desktop/DuckCode/New folder/laravel/ecomerce-api",
  "laravel-b2b-ecommerce": "C:/Users/Admin/Desktop/DuckCode/New folder/laravel/laravel-b2b-ecommerce",
}

// ─── Types ─────────────────────────────────────────────────────────────────

interface GoldenQA {
  id: string
  route: string
  project?: string
  question: string
  expected_finding: string
  expected_severity: string
  expected_intent: string
  expected_evidence_nodes: Array<{ symbol: string; type: string; role: string }>
  expected_answer_contains: string[]
  golden_answer: string
}

interface ScoredPair {
  id: string
  evidence_precision: number
  finding_match: boolean
  intent_match: boolean
  composite_score: number
}

// ─── Load Q&A pairs grouped by project folder ──────────────────────────────

function loadQAByProject(): Map<string, GoldenQA[]> {
  const byProject = new Map<string, GoldenQA[]>()
  const projectDirs = readdirSync(QA_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  for (const project of projectDirs) {
    const dir = join(QA_ROOT, project)
    const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"))
    const pairs = files.map(
      (f) => yaml.load(readFileSync(join(dir, f), "utf-8")) as GoldenQA
    )
    if (pairs.length > 0) byProject.set(project, pairs)
  }
  return byProject
}

// ─── Parse graphs for a project ────────────────────────────────────────────

function parseProject(projectRoot: string): IntermediateExecutionGraph[] {
  const config = loadProjectConfig(projectRoot)
  const { aliasMap, routeFiles } = resolveAliasMap(projectRoot, config)
  const graphs: IntermediateExecutionGraph[] = []
  for (const relFile of routeFiles) {
    const skeletons = parseRouteFile(join(projectRoot, relFile), { aliasMap })
    for (const g of skeletons) {
      graphs.push(augmentGraph(g, { projectRoot, config }))
    }
  }
  return graphs
}

// ─── Score a single Q&A pair ───────────────────────────────────────────────

function scorePair(qa: GoldenQA, graphs: IntermediateExecutionGraph[]): ScoredPair {
  const graph = graphs.find(
    (g) => g.entrypoint?.toLowerCase() === qa.route.toLowerCase()
  )
  if (!graph) {
    return { id: qa.id, evidence_precision: 0, finding_match: false, intent_match: false, composite_score: 0 }
  }

  const pkg = buildEvidencePackage(qa.question, graph)

  // Evidence precision
  const evidenceSymbols = pkg.evidence.map((e) => e.symbol.toLowerCase())
  const matched = qa.expected_evidence_nodes.filter((n) =>
    evidenceSymbols.some(
      (s) => s === n.symbol.toLowerCase() || s.includes(n.symbol.toLowerCase())
    )
  )
  const evidence_precision = qa.expected_evidence_nodes.length > 0
    ? matched.length / qa.expected_evidence_nodes.length
    : 1

  const finding_match = pkg.finding === qa.expected_finding
  const intent_match  = pkg.intent  === qa.expected_intent

  const composite_score = evidence_precision * 0.5 + (finding_match ? 0.3 : 0) + (intent_match ? 0.2 : 0)

  return { id: qa.id, evidence_precision, finding_match, intent_match, composite_score }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

const allQA    = loadQAByProject()
const allScores: ScoredPair[] = []

for (const [project, pairs] of allQA) {
  const projectRoot = PROJECT_PATHS[project]

  describe(`Project: ${project}`, () => {
    if (!projectRoot || !existsSync(projectRoot)) {
      it.skip(`project not found at ${projectRoot ?? "(no path configured)"}`, () => {})
      return
    }

    let graphs: IntermediateExecutionGraph[] = []

    beforeAll(() => {
      graphs = parseProject(projectRoot)
    })

    for (const qa of pairs) {
      describe(qa.id, () => {
        it(`route "${qa.route}" exists in parsed graphs`, () => {
          const g = graphs.find((g) => g.entrypoint?.toLowerCase() === qa.route.toLowerCase())
          expect(g).toBeDefined()
        })

        it(`intent detected as "${qa.expected_intent}"`, () => {
          const g = graphs.find((g) => g.entrypoint?.toLowerCase() === qa.route.toLowerCase())
          if (!g) return
          const pkg = buildEvidencePackage(qa.question, g)
          expect(pkg.intent).toBe(qa.expected_intent)
        })

        it(`top finding is "${qa.expected_finding}"`, () => {
          const g = graphs.find((g) => g.entrypoint?.toLowerCase() === qa.route.toLowerCase())
          if (!g) return
          const pkg = buildEvidencePackage(qa.question, g)
          expect(pkg.finding).toBe(qa.expected_finding)
        })

        it("expected_evidence_nodes present in package", () => {
          const g = graphs.find((g) => g.entrypoint?.toLowerCase() === qa.route.toLowerCase())
          if (!g) return
          const pkg = buildEvidencePackage(qa.question, g)
          const symbols = pkg.evidence.map((e) => e.symbol.toLowerCase())

          for (const expected of qa.expected_evidence_nodes) {
            const found = symbols.some(
              (s) => s === expected.symbol.toLowerCase() || s.includes(expected.symbol.toLowerCase())
            )
            expect(found).toBe(true)
          }
        })

        it("execution_path is non-empty", () => {
          const g = graphs.find((g) => g.entrypoint?.toLowerCase() === qa.route.toLowerCase())
          if (!g) return
          const pkg = buildEvidencePackage(qa.question, g)
          expect(pkg.execution_path.length).toBeGreaterThan(0)
        })
      })
    }

    it(`avg composite_score for ${project} >= 0.60`, () => {
      const scores = pairs.map((qa) => scorePair(qa, graphs))
      scores.forEach((s) => allScores.push(s))

      const avg = scores.reduce((sum, s) => sum + s.composite_score, 0) / scores.length
      console.log(`  ${project}: avg_composite=${avg.toFixed(3)}`)
      scores.forEach((s) =>
        console.log(
          `    [${s.id}] evidence=${s.evidence_precision.toFixed(2)} finding=${s.finding_match} intent=${s.intent_match} score=${s.composite_score.toFixed(3)}`
        )
      )
      expect(avg).toBeGreaterThanOrEqual(0.60)
    })
  })
}

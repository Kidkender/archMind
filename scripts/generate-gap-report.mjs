/**
 * Phase 18A.3 — Runtime Gap Report
 *
 * Usage:
 *   node scripts/generate-gap-report.mjs <traces-dir> <project-root>
 *
 * Example:
 *   node scripts/generate-gap-report.mjs research/corpus/traces/laravel-io /path/to/laravel-io
 *
 * It reads all OTLP JSON files from <traces-dir>, parses + correlates them
 * against the ArchMind execution graph of <project-root>, then prints a
 * Runtime Coverage Score with breakdown by semantic category.
 */

import { readdirSync, writeFileSync } from "fs"
import { join, resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")

async function main() {
  const [tracesDir, projectRoot] = process.argv.slice(2)

  if (!tracesDir || !projectRoot) {
    console.error("Usage: node generate-gap-report.mjs <traces-dir> <project-root>")
    process.exit(1)
  }

  const absTracesDir = resolve(tracesDir)
  const absProjectRoot = resolve(projectRoot)

  // Dynamic imports — built packages required
  const { ingestOtlpFile } = await import(
    join(ROOT, "packages/runtime-ingest/dist/index.js")
  )
  const { correlateSession, generateGapReport } = await import(
    join(ROOT, "packages/runtime-correlator/dist/index.js")
  )
  const { parseProject } = await import(
    join(ROOT, "packages/laravel-parser/dist/index.js")
  )

  console.log(`[gap-report] Parsing project: ${absProjectRoot}`)
  const graphs = await parseProject(absProjectRoot)
  const allNodes = graphs.flatMap(g => g.nodes)
  console.log(`[gap-report] Graph nodes: ${allNodes.length} across ${graphs.length} routes`)

  // Load all trace files
  const traceFiles = readdirSync(absTracesDir).filter(f => f.endsWith(".json"))
  if (traceFiles.length === 0) {
    console.error(`[gap-report] No trace files found in ${absTracesDir}`)
    console.error("  → Run the app with OTLP enabled and the otlp-collector to generate traces first.")
    process.exit(1)
  }

  console.log(`[gap-report] Loading ${traceFiles.length} trace file(s)...`)

  // Aggregate correlations across all traces
  let totalSpans = 0, matchedSpans = 0
  const categoryTotals = new Map()
  const categoryExamples = new Map()

  for (const file of traceFiles) {
    const session = ingestOtlpFile(join(absTracesDir, file))
    // Use a synthetic single-graph with all nodes for cross-route correlation
    const syntheticGraph = { nodes: allNodes, edges: [], routeId: "_all", framework: "laravel" }
    const correlated = correlateSession(session, syntheticGraph)
    const report = generateGapReport(correlated)

    totalSpans += report.totalSpans
    matchedSpans += report.matchedSpans

    for (const b of report.breakdown) {
      categoryTotals.set(b.category, (categoryTotals.get(b.category) ?? 0) + b.count)
      if (!categoryExamples.has(b.category)) categoryExamples.set(b.category, b.examples)
    }
  }

  const coverageScore = totalSpans > 0 ? matchedSpans / totalSpans : 0
  const unmatchedTotal = totalSpans - matchedSpans

  // Build aggregated breakdown
  const breakdown = Array.from(categoryTotals.entries())
    .map(([category, count]) => ({
      category,
      count,
      percentage: totalSpans > 0 ? Math.round((count / totalSpans) * 100) : 0,
      examples: categoryExamples.get(category) ?? [],
    }))
    .sort((a, b) => b.count - a.count)

  // Print report
  console.log("\n" + "=".repeat(60))
  console.log("ARCHMIND — RUNTIME COVERAGE REPORT")
  console.log("=".repeat(60))
  console.log(`Project:        ${absProjectRoot}`)
  console.log(`Trace files:    ${traceFiles.length}`)
  console.log(`Total spans:    ${totalSpans}`)
  console.log(`Matched:        ${matchedSpans}  (${Math.round(coverageScore * 100)}%)`)
  console.log(`Unmatched:      ${unmatchedTotal}  (${Math.round((1 - coverageScore) * 100)}%)`)
  console.log("-".repeat(60))
  console.log("Unmatched Breakdown (sorted by count):")

  const infraCategories = ["db_infra", "http_infra", "cache_infra"]
  for (const b of breakdown) {
    const isInfra = infraCategories.includes(b.category)
    const tag = isInfra ? " [infra - expected]" : " ← PARSER GAP"
    const bar = "█".repeat(Math.round(b.percentage / 3))
    console.log(`  ${b.category.padEnd(22)} ${String(b.percentage + "%").padStart(4)}  ${bar}${tag}`)
    if (b.examples.length > 0 && !isInfra) {
      console.log(`    e.g. ${b.examples.join(", ")}`)
    }
  }

  console.log("-".repeat(60))
  console.log("Top Parser Targets (coverage increase estimate):")
  const gaps = breakdown.filter(b => !infraCategories.includes(b.category))
  let cumulative = Math.round(coverageScore * 100)
  for (const g of gaps.slice(0, 5)) {
    const after = cumulative + g.percentage
    console.log(`  → Add ${g.category} parser: ${cumulative}% → ${after}%`)
    cumulative = after
  }
  console.log("=".repeat(60))

  // Save JSON report
  const reportPath = join(ROOT, "research", "corpus", "gap-report.json")
  const reportData = {
    generatedAt: new Date().toISOString(),
    projectRoot: absProjectRoot,
    traceFiles: traceFiles.length,
    totalSpans,
    matchedSpans,
    unmatchedSpans: unmatchedTotal,
    coverageScore,
    breakdown,
  }
  writeFileSync(reportPath, JSON.stringify(reportData, null, 2))
  console.log(`\n[gap-report] JSON report saved to ${reportPath}`)
}

main().catch(e => { console.error(e); process.exit(1) })

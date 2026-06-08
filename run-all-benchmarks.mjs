import { join } from "path"
import { readdirSync, readFileSync } from "fs"
import { pathToFileURL } from "url"

const REPO_ROOT = "C:/Users/Admin/Desktop/DuckCode/Project/archMind"

const { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap } = await import(
  pathToFileURL(join(REPO_ROOT, "packages/laravel-parser/dist/index.js")).href
)
const { runBenchmark } = await import(
  pathToFileURL(join(REPO_ROOT, "packages/retrieval/dist/benchmark.js")).href
)
const yaml = (await import("js-yaml")).default

const PROJECTS = [
  { name: "easygo",         dir: "C:/Users/Admin/Desktop/DuckCode/New folder/laravel/easygo-shopping-laravel",  golden: "easygo" },
  { name: "easygo-biz",     dir: "C:/Users/Admin/Desktop/DuckCode/New folder/laravel/easygo-shopping-laravel",  golden: "easygo-business" },
  { name: "obsidian",       dir: "C:/Users/Admin/Desktop/DuckCode/New folder/laravel/obsidian-admin-laravel",   golden: "obsidian" },
  { name: "b2b",            dir: "C:/Users/Admin/Desktop/DuckCode/New folder/laravel/laravel-b2b-ecommerce",    golden: "laravel-b2b-ecommerce" },
  { name: "ecomerce",       dir: "C:/Users/Admin/Desktop/DuckCode/New folder/laravel/ecomerce-api",             golden: "ecomerce-api" },
]

for (const proj of PROJECTS) {
  const goldenDir = join(REPO_ROOT, "research/golden-traces", proj.golden)
  try {
    const config = loadProjectConfig(proj.dir)
    const { aliasMap, routeFiles } = resolveAliasMap(proj.dir, config)
    
    const allGraphs = []
    for (const relFile of routeFiles) {
      const skeletons = parseRouteFile(join(proj.dir, relFile), { aliasMap })
      for (const g of skeletons) allGraphs.push(augmentGraph(g, { projectRoot: proj.dir, config }))
    }
    
    const traceFiles = readdirSync(goldenDir).filter(f => f.endsWith(".yaml"))
    const graphs = {}
    for (const tf of traceFiles) {
      const trace = yaml.load(readFileSync(join(goldenDir, tf), "utf-8"))
      graphs[trace.id] = allGraphs.filter(g => g.entrypoint === trace.entrypoint)
    }
    
    const snap = runBenchmark({ goldenDir, fixtureDir: proj.dir, graphs, label: proj.name + "-current" })
    
    console.log(`\n=== ${proj.name.toUpperCase()} (${Object.keys(graphs).length} traces) ===`)
    console.log(`  avg_recall: ${snap.summary.avg_r0_recall}  compression: ${snap.summary.avg_compression_r0}x  savings: ${snap.summary.avg_token_savings_r0}%`)
    for (const [id, t] of Object.entries(snap.traces)) {
      const skip = t.recall_gap_reason === "cross_cutting"
      const ok   = t.r0_recall >= 0.8
      const icon = skip ? "⊘" : (ok ? "✓" : "✗")
      const detail = skip ? "(cross_cutting)" : `recall=${t.r0_recall} cmp=${t.compression_r0}x`
      console.log(`  [${icon}] ${id}: ${detail}`)
      if (t.missing_high_nodes?.length) console.log(`       MISSING: ${t.missing_high_nodes.join(", ")}`)
    }
  } catch (err) {
    console.log(`\n=== ${proj.name.toUpperCase()} === ERROR: ${err.message.split("\n")[0]}`)
  }
}

// ---- NestJS benchmarks ----
const { parseNestJSProject } = await import(
  pathToFileURL(join(REPO_ROOT, "packages/nestjs-parser/dist/index.js")).href
)
const { loadGoldenTrace, scoreRetrieval } = await import(
  pathToFileURL(join(REPO_ROOT, "packages/scorer/dist/index.js")).href
)
const { retrieve } = await import(
  pathToFileURL(join(REPO_ROOT, "packages/retrieval/dist/retrieval-engine.js")).href
)

const NESTJS_PROJECTS = [
  { name: "nestjs-ipfs",       dir: "C:/Users/Admin/Desktop/DuckCode/IPFS-api",       golden: "nestjs-ipfs" },
  { name: "nestjs-education",  dir: "C:/Users/Admin/Desktop/DuckCode/education-api",  golden: "nestjs-education" },
]

for (const proj of NESTJS_PROJECTS) {
  const goldenDir = join(REPO_ROOT, "research/golden-traces", proj.golden)
  try {
    const allGraphs = parseNestJSProject(proj.dir)
    const traceFiles = readdirSync(goldenDir).filter(f => f.endsWith(".yaml"))
    
    console.log(`\n=== ${proj.name.toUpperCase()} (${traceFiles.length} traces) ===`)
    console.log(`  Extracted ${allGraphs.length} NestJS graphs`)
    
    for (const tf of traceFiles) {
      const golden = loadGoldenTrace(join(goldenDir, tf))
      const matching = allGraphs.filter(g => g.entrypoint === golden.entrypoint)
      const r0 = retrieve({ entrypoint: golden.entrypoint }, matching)
      if (!r0) { console.log(`  [⊘] ${golden.id}: no match`); continue }
      const score = scoreRetrieval(golden, r0)
      const ok = score.combined_recall >= 0.8
      console.log(`  [${ok ? "✓" : "✗"}] ${golden.id}: recall=${score.combined_recall.toFixed(2)} nodes=${r0.nodes.length}`)
      if (score.combined_recall < 1.0) {
        const missing = golden.nodes.filter(n => n.retrieval?.relevance === "HIGH" && !r0.nodes.some(e => e.symbol.toLowerCase().includes(n.symbol.toLowerCase()) || n.symbol.toLowerCase().includes(e.symbol.toLowerCase())))
        if (missing.length) console.log(`       MISSING HIGH: ${missing.map(n=>n.symbol).join(", ")}`)
      }
    }
  } catch (err) {
    console.log(`\n=== ${proj.name.toUpperCase()} === ERROR: ${err.message.split("\n")[0]}`)
  }
}

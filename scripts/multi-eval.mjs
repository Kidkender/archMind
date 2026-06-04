/**
 * Multi-project benchmark eval — NestJS + Laravel
 *
 * Usage: node scripts/multi-eval.mjs
 *
 * Evaluates ArchMind adapter quality across repos in:
 *   C:\Users\Admin\Desktop\DuckCode\New folder\nestjs\
 *   C:\Users\Admin\Desktop\DuckCode\New folder\laravel\
 *
 * Reports per-project and aggregate:
 *   - Routes found
 *   - Auth/authz/validation coverage %
 *   - Token savings vs naive RAG (controller file dump)
 *   - Guard coverage (for NestJS: unknown_guard rate)
 */

import { readdirSync, existsSync, statSync } from "fs"
import { join } from "path"
import { pathToFileURL } from "url"

// ---- Adapter imports (from dist) -----------------------------------------

const REPO_ROOT = new URL("../", import.meta.url)

function distUrl(pkgPath) {
  return new URL(pkgPath, REPO_ROOT).href
}

const { parseNestJSProject } = await import(distUrl("packages/nestjs-parser/dist/adapter.js"))

const { parseRouteFile, augmentGraph, inferProjectConfig, resolveAliasMap, expandRouteFiles } = await import(
  distUrl("packages/laravel-parser/dist/index.js")
)

// ---- Paths ---------------------------------------------------------------

const BASE = "C:\\Users\\Admin\\Desktop\\DuckCode\\New folder"
const NESTJS_DIR = join(BASE, "nestjs")
const LARAVEL_DIR = join(BASE, "laravel")

// ---- Helpers -------------------------------------------------------------

function estimateTokens(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4)
}

function readFileSizeTokens(filePath) {
  if (!existsSync(filePath)) return 0
  return Math.ceil(statSync(filePath).size / 4)
}

function naiveRagTokensForRoute(projectRoot, filePath) {
  if (!filePath) return 0
  const abs = join(projectRoot, filePath)
  return readFileSizeTokens(abs)
}

function pct(n, total) {
  if (!total) return "n/a"
  return ((n / total) * 100).toFixed(0) + "%"
}

function ratio(a, b) {
  if (!b || b === 0) return "n/a"
  return (a / b).toFixed(1) + "x"
}

// ---- NestJS Eval ---------------------------------------------------------

function evalNestJS(projectRoot, name) {
  let graphs
  try {
    graphs = parseNestJSProject(projectRoot)
  } catch (e) {
    return { name, error: e.message, routes: 0 }
  }

  if (!graphs.length) return { name, routes: 0, error: "no routes found" }

  let authRoutes = 0
  let authzRoutes = 0
  let validationRoutes = 0
  let unknownGuardRoutes = 0
  let publicRoutes = 0
  let totalArchmindTokens = 0
  let totalNaiveTokens = 0

  for (const g of graphs) {
    const types = new Set(g.nodes.map(n => n.type))
    const hasAuth     = types.has("ir:auth_gate")
    const hasAuthz    = types.has("ir:authz_check")
    const hasVal      = types.has("ir:validation_gate")
    const hasUnknown  = types.has("unknown_guard")
    const isPublic    = g.nodes.length === 1  // only business_handler = public

    if (hasAuth)    authRoutes++
    if (hasAuthz)   authzRoutes++
    if (hasVal)     validationRoutes++
    if (hasUnknown) unknownGuardRoutes++
    if (isPublic)   publicRoutes++

    const archTokens  = estimateTokens({ nodes: g.nodes, edges: g.edges })
    totalArchmindTokens += archTokens

    // Naive RAG: controller file for this route
    const handlerNode = g.nodes.find(n => n.type === "ir:business_handler")
    const naiveTokens = naiveRagTokensForRoute(projectRoot, handlerNode?.file)
    totalNaiveTokens += naiveTokens || archTokens * 3  // fallback estimate if no file
  }

  const routes = graphs.length
  const avgArch  = Math.round(totalArchmindTokens / routes)
  const avgNaive = Math.round(totalNaiveTokens / routes)

  return {
    name,
    routes,
    authRoutes,
    authzRoutes,
    validationRoutes,
    unknownGuardRoutes,
    publicRoutes,
    avgArchmindTokens: avgArch,
    avgNaiveTokens:    avgNaive,
    compressionRatio:  totalNaiveTokens > 0 ? (totalNaiveTokens / totalArchmindTokens).toFixed(1) : "n/a",
  }
}

// ---- Laravel Eval --------------------------------------------------------

function findLaravelRouteFiles(projectRoot) {
  const routesDir = join(projectRoot, "routes")
  if (!existsSync(routesDir)) return []
  const found = []
  for (const entry of readdirSync(routesDir)) {
    const abs = join(routesDir, entry)
    const s = statSync(abs)
    if (s.isFile() && entry.endsWith(".php")) {
      found.push(abs)
    } else if (s.isDirectory()) {
      // One level deep: routes/api/, routes/frontend/, etc.
      for (const sub of readdirSync(abs)) {
        const subAbs = join(abs, sub)
        if (sub.endsWith(".php") && statSync(subAbs).isFile()) found.push(subAbs)
      }
    }
  }
  return found
}

async function evalLaravel(projectRoot, name) {
  try {
    const config = inferProjectConfig(projectRoot)
    if (!config) return { name, routes: 0, error: "cannot infer config" }

    const aliasMap = resolveAliasMap(projectRoot, config)
    const routeFiles = findLaravelRouteFiles(projectRoot)
    if (!routeFiles.length) return { name, routes: 0, error: "no route files" }

    let allGraphs = []
    for (const rf of routeFiles) {
      try {
        const graphs = parseRouteFile(rf, { aliasMap })
        allGraphs.push(...graphs)
      } catch {}
    }

    if (!allGraphs.length) return { name, routes: 0, error: "parse yielded 0 routes" }

    // Sample 20 routes distributed across the route list (skip first 5 which tend to be auth/login)
    const step = Math.max(1, Math.floor(allGraphs.length / 20))
    const sample = allGraphs.length <= 20
      ? allGraphs
      : Array.from({ length: 20 }, (_, i) => allGraphs[Math.min(5 + i * step, allGraphs.length - 1)])
    const augmented = []
    for (const g of sample) {
      try {
        const aug = augmentGraph(g, { projectRoot, config })
        augmented.push(aug)
      } catch {
        augmented.push(g)
      }
    }

    let authRoutes = 0
    let authzRoutes = 0
    let validationRoutes = 0
    let totalArchmindTokens = 0
    let totalNaiveTokens = 0

    for (const g of augmented) {
      const types = new Set(g.nodes.map(n => n.type))
      // Check both IR and legacy types
      const hasAuth  = types.has("ir:auth_gate") || types.has("authentication_gate")
      const hasAuthz = types.has("ir:authz_check") || types.has("authorization_check") || types.has("policy")
      const hasVal   = types.has("ir:validation_gate") || types.has("form_request")

      if (hasAuth)  authRoutes++
      if (hasAuthz) authzRoutes++
      if (hasVal)   validationRoutes++

      const archTokens = estimateTokens({ nodes: g.nodes, edges: g.edges })
      totalArchmindTokens += archTokens

      const handlerNode = g.nodes.find(n =>
        n.type === "ir:business_handler" || n.type === "controller_action"
      )
      const naiveTokens = naiveRagTokensForRoute(projectRoot, handlerNode?.file)
      totalNaiveTokens += naiveTokens || archTokens * 3
    }

    const sampledRoutes = augmented.length
    const avgArch  = Math.round(totalArchmindTokens / sampledRoutes)
    const avgNaive = Math.round(totalNaiveTokens / sampledRoutes)

    return {
      name,
      routes:        allGraphs.length,
      sampledRoutes,
      authRoutes,
      authzRoutes,
      validationRoutes,
      avgArchmindTokens: avgArch,
      avgNaiveTokens:    avgNaive,
      compressionRatio:  totalNaiveTokens > 0 ? (totalNaiveTokens / totalArchmindTokens).toFixed(1) : "n/a",
    }
  } catch (e) {
    return { name, routes: 0, error: e.message?.slice(0, 80) }
  }
}

// ---- Main ----------------------------------------------------------------

console.log("\n" + "═".repeat(72))
console.log("  ArchMind Multi-Project Eval")
console.log("  NestJS ×10   Laravel ×12")
console.log("═".repeat(72))

// -- NestJS ----------------------------------------------------------------
console.log("\n▶ NestJS Projects\n")
const nestjsNames = readdirSync(NESTJS_DIR).filter(d =>
  statSync(join(NESTJS_DIR, d)).isDirectory()
)

const nestResults = []
for (const name of nestjsNames) {
  process.stdout.write(`  Parsing ${name.padEnd(40)}`)
  const r = evalNestJS(join(NESTJS_DIR, name), name)
  nestResults.push(r)
  if (r.error) {
    console.log(`ERROR: ${r.error}`)
  } else {
    console.log(`${String(r.routes).padStart(3)} routes  auth=${pct(r.authRoutes, r.routes).padStart(4)}  authz=${pct(r.authzRoutes, r.routes).padStart(4)}  val=${pct(r.validationRoutes, r.routes).padStart(4)}  compression=${String(r.compressionRatio).padStart(5)}  unknown_guard=${pct(r.unknownGuardRoutes, r.routes).padStart(4)}`)
  }
}

// Aggregate NestJS
const nestOk = nestResults.filter(r => !r.error && r.routes > 0)
if (nestOk.length) {
  const totalRoutes = nestOk.reduce((s, r) => s + r.routes, 0)
  const totalAuth   = nestOk.reduce((s, r) => s + r.authRoutes, 0)
  const totalAuthz  = nestOk.reduce((s, r) => s + r.authzRoutes, 0)
  const totalVal    = nestOk.reduce((s, r) => s + r.validationRoutes, 0)
  const totalUnk    = nestOk.reduce((s, r) => s + r.unknownGuardRoutes, 0)
  const avgCompr    = (nestOk.reduce((s, r) => s + parseFloat(r.compressionRatio) || 0, 0) / nestOk.length).toFixed(1)
  console.log(`\n  ${"TOTAL".padEnd(40)}${String(totalRoutes).padStart(3)} routes  auth=${pct(totalAuth, totalRoutes).padStart(4)}  authz=${pct(totalAuthz, totalRoutes).padStart(4)}  val=${pct(totalVal, totalRoutes).padStart(4)}  compression=${String(avgCompr + "x").padStart(5)}  unknown_guard=${pct(totalUnk, totalRoutes).padStart(4)}`)
}

// -- Laravel ---------------------------------------------------------------
console.log("\n▶ Laravel Projects\n")
const laravelNames = readdirSync(LARAVEL_DIR).filter(d =>
  statSync(join(LARAVEL_DIR, d)).isDirectory()
)

const laravelResults = []
for (const name of laravelNames) {
  process.stdout.write(`  Parsing ${name.padEnd(40)}`)
  const r = await evalLaravel(join(LARAVEL_DIR, name), name)
  laravelResults.push(r)
  if (r.error) {
    console.log(`ERROR: ${r.error}`)
  } else {
    console.log(`${String(r.routes).padStart(3)} routes (sampled ${r.sampledRoutes})  auth=${pct(r.authRoutes, r.sampledRoutes).padStart(4)}  authz=${pct(r.authzRoutes, r.sampledRoutes).padStart(4)}  val=${pct(r.validationRoutes, r.sampledRoutes).padStart(4)}  compression=${String(r.compressionRatio).padStart(5)}`)
  }
}

// Aggregate Laravel
const laravelOk = laravelResults.filter(r => !r.error && r.routes > 0)
if (laravelOk.length) {
  const totalRoutes   = laravelOk.reduce((s, r) => s + (r.sampledRoutes ?? r.routes), 0)
  const totalAuth     = laravelOk.reduce((s, r) => s + r.authRoutes, 0)
  const totalAuthz    = laravelOk.reduce((s, r) => s + r.authzRoutes, 0)
  const totalVal      = laravelOk.reduce((s, r) => s + r.validationRoutes, 0)
  const avgCompr      = (laravelOk.reduce((s, r) => s + parseFloat(r.compressionRatio) || 0, 0) / laravelOk.length).toFixed(1)
  console.log(`\n  ${"TOTAL".padEnd(40)}${String(totalRoutes).padStart(3)} routes           auth=${pct(totalAuth, totalRoutes).padStart(4)}  authz=${pct(totalAuthz, totalRoutes).padStart(4)}  val=${pct(totalVal, totalRoutes).padStart(4)}  compression=${String(avgCompr + "x").padStart(5)}`)
}

console.log("\n" + "═".repeat(72))
console.log("  LEGEND:")
console.log("  auth = % routes with authentication guard")
console.log("  authz = % routes with authorization check")
console.log("  val = % routes with validation gate")
console.log("  compression = naive RAG file dump ÷ ArchMind graph tokens")
console.log("  unknown_guard = % NestJS routes with unclassified guard (gap in classifier)")
console.log("═".repeat(72) + "\n")

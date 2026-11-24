import { explain } from "@kidkender/archmind-explainer"
import type { Finding } from "@kidkender/archmind-explainer"
import { loadUserConfig } from "@kidkender/archmind-protocol"
import { parseProject, requireProject } from "../utils/parse-project.js"

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"]

const SEVERITY_PREFIX: Record<string, string> = {
  critical: "✘ CRITICAL",
  high:     "! HIGH    ",
  medium:   "~ MEDIUM  ",
  low:      "· LOW     ",
  info:     "  INFO    ",
}

export function runFindings(flags: Record<string, string>, positional: string[]): void {
  const projectRoot = requireProject(flags)
  const routeFilter = positional[0]
  const isJson      = "json" in flags
  const showAll     = "all" in flags

  const { graphs } = parseProject(projectRoot)
  const ignore = loadUserConfig(projectRoot)?.ignoreFindings

  let allFindings: Array<{ route: string; finding: Finding }> = []

  for (const g of graphs) {
    const routeKey = `${g.method} ${g.path}`
    if (routeFilter) {
      const needle = routeFilter.toLowerCase()
      if (!routeKey.toLowerCase().includes(needle) && !g.path.toLowerCase().includes(needle)) {
        continue
      }
    }
    const findings = explain(g, undefined, { ignore })
    for (const f of findings) {
      allFindings.push({ route: routeKey, finding: f })
    }
  }

  // Shown by default: CRITICAL / HIGH / MEDIUM. LOW findings are code-quality
  // notes (fat_controller…) and INFO ones describe the graph ("authorization is
  // delegated to middleware") — both hidden unless --all. Only CRITICAL/HIGH fail CI.
  const isProblem = (f: Finding): boolean => ["critical", "high", "medium"].includes(f.severity.toLowerCase())
  const failsBuild = allFindings.some(({ finding: f }) => ["critical", "high"].includes(f.severity.toLowerCase()))

  if (isJson) {
    // Use exitCode + return so stdout flushes before the process ends
    process.exitCode = graphs.length === 0 ? 2 : failsBuild ? 1 : 0
    process.stdout.write(JSON.stringify(allFindings, null, 2) + "\n")
    return
  }

  if (graphs.length === 0) {
    // parseProject already explained why on stderr; don't claim a clean result
    console.log("No entrypoints analyzed — no findings can be reported.")
    process.exit(2)
  }

  const hiddenInfo = showAll ? 0 : allFindings.filter(({ finding }) => !isProblem(finding)).length
  if (!showAll) allFindings = allFindings.filter(({ finding }) => isProblem(finding))

  if (allFindings.length === 0) {
    console.log(hiddenInfo > 0 ? `No findings (${hiddenInfo} low/informational hidden — use --all).` : "No findings.")
    process.exit(0)
  }

  // Sort by severity
  allFindings.sort((a, b) => {
    const ai = SEVERITY_ORDER.indexOf(a.finding.severity.toLowerCase())
    const bi = SEVERITY_ORDER.indexOf(b.finding.severity.toLowerCase())
    return ai - bi
  })

  // Group by route for readability
  const byRoute = new Map<string, Finding[]>()
  for (const { route, finding } of allFindings) {
    if (!byRoute.has(route)) byRoute.set(route, [])
    byRoute.get(route)!.push(finding)
  }

  let total = 0
  for (const [route, findings] of byRoute) {
    console.log(`\n${route}`)
    for (const f of findings) {
      const prefix = SEVERITY_PREFIX[f.severity.toLowerCase()] ?? "  "
      console.log(`  ${prefix}  ${f.type}`)
      if (f.summary) {
        console.log(`             ${f.summary}`)
      }
      total++
    }
  }

  console.log(
    `\n${total} finding(s) across ${byRoute.size} route(s)` +
    (hiddenInfo > 0 ? ` — ${hiddenInfo} low/informational hidden, use --all` : ""),
  )

  const hasHighPlus = allFindings.some(({ finding: f }) =>
    ["critical", "high"].includes(f.severity.toLowerCase())
  )
  process.exit(hasHighPlus ? 1 : 0)
}

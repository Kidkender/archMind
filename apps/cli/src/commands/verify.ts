import { join, dirname } from "path"
import { fileURLToPath } from "url"
import {
  captureTopologyBaseline,
  verifyTopologyBaseline,
  saveTopologyBaseline,
  loadTopologyBaseline,
  DANGER_NODE_TYPES,
} from "@archmind/retrieval"
import { parseProject, requireProject } from "../utils/parse-project.js"

const __filename   = fileURLToPath(import.meta.url)
const __dirname    = dirname(__filename)
// apps/cli/dist/commands/ → up 4 levels → repo root
const REPO_ROOT    = join(__dirname, "../../../..")
const BASELINE_DIR = join(REPO_ROOT, "benchmarks/topology-baselines")

export async function runVerify(flags: Record<string, string>): Promise<void> {
  const projectRoot = requireProject(flags)
  const label       = flags["label"] ?? "topology-main"
  const mode        = flags["update"] !== undefined ? "update" : "verify"

  console.log(`Parsing: ${projectRoot}`)
  const { graphs, routeCount, fileCount } = parseProject(projectRoot)
  console.log(`Parsed ${routeCount} routes from ${fileCount} file(s)\n`)

  const current = captureTopologyBaseline({ graphs, label, projectRoot })

  if (mode === "update") {
    const out = saveTopologyBaseline(current, BASELINE_DIR)
    console.log(`Baseline saved: ${out}`)
    console.log(`Routes: ${routeCount}`)
    for (const [route, entry] of Object.entries(current.entries)) {
      const types = entry.critical_node_types.length > 0
        ? entry.critical_node_types.join(", ")
        : "(none)"
      console.log(`  ${route.padEnd(55)} [${types}]`)
    }
    process.exit(0)
  }

  const stored = loadTopologyBaseline(BASELINE_DIR, label)
  if (!stored) {
    console.log(`No baseline found at benchmarks/topology-baselines/${label}.json`)
    console.log("Run with --update to create one.")
    process.exit(0)
  }

  const result = verifyTopologyBaseline(current, stored)

  if (result.new_routes.length > 0) {
    console.log(`New routes (${result.new_routes.length}) — not in baseline:`)
    result.new_routes.forEach((r) => console.log(`  + ${r}`))
    console.log()
  }

  if (result.removed_routes.length > 0) {
    console.error(`Removed routes (${result.removed_routes.length}):`)
    result.removed_routes.forEach((r) => console.error(`  - ${r}`))
    console.error()
  }

  if (result.drifts.length > 0) {
    const regressions = result.drifts.filter((d) => d.changed)
    const additions   = result.drifts.filter((d) => !d.changed)

    if (regressions.length > 0) {
      console.error(`Topology regressions (${regressions.length} route(s)):`)
      for (const d of regressions) {
        console.error(`  ${d.route}`)
        if (d.lost_types.length > 0) {
          console.error(`    lost:   [${d.lost_types.join(", ")}]`)
        }
        const dangerGained = d.gained_types.filter((t) => DANGER_NODE_TYPES.includes(t))
        if (dangerGained.length > 0) {
          console.error(`    danger: [${dangerGained.join(", ")}]`)
        }
      }
      console.error()
    }

    if (additions.length > 0) {
      console.log(`Informational additions (${additions.length} route(s)):`)
      additions.forEach((d) => console.log(`  ${d.route}: gained [${d.gained_types.join(", ")}]`))
      console.log()
    }
  }

  const stable = routeCount - result.drifts.length - result.new_routes.length - result.removed_routes.length
  if (result.ok) {
    console.log(`PASSED (${label}) — ${stable}/${routeCount} routes stable`)
    if (result.new_routes.length > 0) {
      console.log(`  (${result.new_routes.length} new route(s) — run with --update to accept)`)
    }
    process.exit(0)
  } else {
    console.error(`FAILED (${label})`)
    console.error(`  Stable: ${stable}  Regressions: ${result.drifts.filter((d) => d.changed).length}  Removed: ${result.removed_routes.length}`)
    console.error()
    console.error("Run with --update to accept the new baseline if this drift is intentional.")
    process.exit(1)
  }
}

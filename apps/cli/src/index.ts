#!/usr/bin/env node
import { parseConstantClass, parseRouteFile } from "@archmind/laravel-parser"
import { loadGoldenTrace, scoreTrace } from "@archmind/scorer"
import { resolve } from "path"
import { writeFileSync } from "fs"

function main(): void {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || command === "--help") {
    console.log([
      "Usage:",
      "  archmind trace  <routes-file> [--constants <php-file>] [--out <json-file>]",
      "  archmind score  <routes-file> --golden <yaml-file> [--constants <php-file>]",
    ].join("\n"))
    process.exit(0)
  }

  if (command === "trace") {
    runTrace(args.slice(1))
  } else if (command === "score") {
    runScore(args.slice(1))
  } else {
    console.error(`Unknown command: ${command}`)
    process.exit(1)
  }
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1] ?? ""
      i++
    } else if (!flags["_"]) {
      flags["_"] = args[i]
    }
  }
  return flags
}

function runTrace(args: string[]): void {
  const flags = parseFlags(args)
  if (!flags["_"]) { console.error("Missing routes file"); process.exit(1) }

  const routesFile = resolve(flags["_"])
  const constants  = flags["constants"] ? parseConstantClass(resolve(flags["constants"])) : undefined
  const graphs     = parseRouteFile(routesFile, { constants })
  const result     = { routes_found: graphs.length, graphs }
  const json       = JSON.stringify(result, null, 2)

  if (flags["out"]) {
    writeFileSync(resolve(flags["out"]), json, "utf-8")
    console.log(`Wrote ${graphs.length} route(s) to ${flags["out"]}`)
  } else {
    console.log(json)
  }
}

function runScore(args: string[]): void {
  const flags = parseFlags(args)
  if (!flags["_"])      { console.error("Missing routes file"); process.exit(1) }
  if (!flags["golden"]) { console.error("Missing --golden <yaml-file>"); process.exit(1) }

  const routesFile = resolve(flags["_"])
  const goldenFile = resolve(flags["golden"])
  const constants  = flags["constants"] ? parseConstantClass(resolve(flags["constants"])) : undefined

  const graphs = parseRouteFile(routesFile, { constants })
  const golden = loadGoldenTrace(goldenFile)
  const report = scoreTrace(golden, graphs)

  // Print human-readable report
  console.log(`\n=== ${report.golden_id} ===`)
  console.log(`Entrypoint : ${report.entrypoint}`)
  console.log(`Route found: ${report.route_found ? "YES" : "NO"}`)

  if (report.route_found) {
    const s = report.skeleton
    console.log(`\nSkeleton recall: ${(s.recall * 100).toFixed(0)}% (${s.matched}/${s.total} nodes)`)
    console.log(`Edge recall    : ${(report.edge_recall * 100).toFixed(0)}%`)

    console.log("\nNode matches:")
    for (const m of s.matches) {
      const status = m.extracted_id ? `✓ ${m.extracted_id}  [${m.match_reason}]` : "✗ not found"
      console.log(`  ${m.golden_id.padEnd(28)} → ${status}`)
    }

    if (report.deeper.total > 0) {
      console.log(`\nDeeper nodes (${report.deeper.total}) — ${report.deeper.reason}:`)
      console.log(`  ${report.deeper.nodes.join(", ")}`)
    }
  }

  console.log(`\n${report.summary}`)
}

main()

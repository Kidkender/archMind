#!/usr/bin/env node
import { parseConstantClass, parseRouteFile } from "@archmind/laravel-parser"
import { resolve } from "path"
import { writeFileSync } from "fs"

// archmind trace <routes-file> [--constants <php-file>] [--out <json-file>]
function main(): void {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === "--help") {
    console.log("Usage: archmind trace <routes-file> [--constants <php-file>] [--out <json-file>]")
    process.exit(0)
  }

  const routesFile = resolve(args[0])
  const constantsIdx = args.indexOf("--constants")
  const outIdx = args.indexOf("--out")

  const constantsFile = constantsIdx >= 0 ? resolve(args[constantsIdx + 1]) : null
  const outFile = outIdx >= 0 ? resolve(args[outIdx + 1]) : null

  const constants = constantsFile ? parseConstantClass(constantsFile) : undefined

  const graphs = parseRouteFile(routesFile, { constants })

  const result = {
    routes_found: graphs.length,
    graphs,
  }

  const json = JSON.stringify(result, null, 2)

  if (outFile) {
    writeFileSync(outFile, json, "utf-8")
    console.log(`Wrote ${graphs.length} route(s) to ${outFile}`)
  } else {
    console.log(json)
  }
}

main()

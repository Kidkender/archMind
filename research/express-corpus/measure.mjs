#!/usr/bin/env node
// Runs the built express-parser (packages/express-parser/dist) on projects and
// prints what it found, for comparison with count-routes.mjs.
//
//   node measure.mjs <project> [<project> ...] [--routes] [--middleware] [--graph]
//
//   (default)     one line per project: routes found, unresolved paths, time
//   --routes      every route: method, path, middleware names, handler and its file:line
//   --middleware  how often each middleware name was classified as each kind
//   --graph       service calls, transactions and ownership nodes per route
//
// Build the parser first: npm run build -w packages/express-parser
import { pathToFileURL, fileURLToPath } from "url"
import { dirname, join } from "path"

const here = dirname(fileURLToPath(import.meta.url))
const parser = await import(pathToFileURL(join(here, "../../packages/express-parser/dist/index.js")).href)

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith("--")))
const projects = args.filter((a) => !a.startsWith("--"))

for (const project of projects) {
  const name = project.split(/[\\/]/).filter(Boolean).pop()
  const root = parser.findExpressRoot(project)
  if (!root) {
    console.log(`${name}\tnot detected as Express`)
    continue
  }
  const sources = parser.readSourceFiles(root)
  const t0 = Date.now()
  const { routes, unresolvedPaths } = parser.extractRoutes(parser.createExpressProject(sources))
  console.log(`${name}\troutes=${routes.length}\tunresolvedPaths=${unresolvedPaths.length}\t${Date.now() - t0}ms`)

  if (flags.has("--routes")) {
    for (const r of routes) {
      const mw = r.middleware.map((m) => m.name).join(",")
      console.log(`    ${r.method.padEnd(7)} ${r.path.padEnd(44)} [${mw}] -> ${r.handler.symbol} @${r.handler.file}:${r.handler.line}`)
    }
    for (const u of unresolvedPaths) console.log(`    unresolved ${u.file}:${u.line} ${u.text}`)
  }

  if (flags.has("--middleware")) {
    const counts = new Map()
    for (const r of routes) {
      for (const m of r.middleware) {
        const kinds = parser.classifyMiddleware(m).kinds
        if (kinds.every((k) => k === "infrastructure" || k === "error_handler")) continue
        const key = `${m.name}=${kinds.join("+")}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)} ${key}`)
  }

  if (flags.has("--graph")) {
    for (const g of parser.parseExpressSources(sources)) {
      const extra = g.nodes
        .filter((n) => ["ir:service_call", "ir:txn_boundary", "ir:txn_write"].includes(n.type) || n.id === "ownership")
        .map((n) => `${n.type.replace("ir:", "")}:${n.symbol}`)
      if (extra.length) console.log(`    ${g.entrypoint.padEnd(44)} ${extra.join("  ")}`)
    }
  }
}

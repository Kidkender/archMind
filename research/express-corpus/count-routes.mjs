#!/usr/bin/env node
// Approximate count of Express route registration sites, used as the denominator
// when measuring @kidkender/archmind-express-parser on a project:
//   x.get('/path', ...) / x.post(`/path`, ...)   → 1 per call with a path literal and a handler
//   x.route('/path').get(...).post(...)           → 1 per chained verb
// Skips node_modules, tests, build output and front-end folders.
//
// It is a regex count, so it over-counts HTTP client calls with the same shape
// (`axios.post('/x', data)`) and misses paths built at runtime. Differences
// against the parser are checked by hand (see README.md).
//
//   node count-routes.mjs <project> [<project> ...]
import { readdirSync, readFileSync, statSync } from "fs"
import { join, relative } from "path"

const SKIP = new Set(["node_modules", "dist", "build", "coverage", ".git", "public", "client", "frontend", "test", "tests", "__tests__", "views"])
const VERBS = "get|post|put|patch|delete|all|options|head"

function files(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e) || e.startsWith(".")) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) files(p, out)
    else if (/\.(js|ts|mjs|cjs)$/.test(e) && !/\.(test|spec)\./.test(e) && !e.endsWith(".d.ts")) out.push(p)
  }
  return out
}

for (const project of process.argv.slice(2)) {
  let direct = 0
  let chained = 0
  const perFile = {}
  for (const f of files(project)) {
    const src = readFileSync(f, "utf-8")
    const d = (src.match(new RegExp(`\\.(${VERBS})\\(\\s*['"\`][^'"\`]*['"\`]\\s*,`, "g")) ?? []).length
    let c = 0
    for (const m of src.matchAll(/\.route\(\s*['"`][^'"`]*['"`]\s*\)/g)) {
      // the chain runs until the statement ends (`;`) or the next `x.route(` / `x.use(`
      const rest = src.slice(m.index + m[0].length)
      const end = rest.search(/;|\n\s*\w+\.(route|use)\(/)
      const chain = end === -1 ? rest : rest.slice(0, end)
      c += (chain.match(new RegExp(`(^|\\n)\\s*\\.\\s*(${VERBS})\\(|\\)\\s*\\.\\s*(${VERBS})\\(|^\\s*\\.(${VERBS})\\(`, "g")) ?? []).length
    }
    if (d + c) perFile[relative(project, f).replace(/\\/g, "/")] = d + c
    direct += d
    chained += c
  }
  console.log(`${project.split(/[\\/]/).pop()}\t${direct + chained}\t(direct ${direct}, route-chain ${chained})`)
  for (const [f, n] of Object.entries(perFile)) console.log(`    ${n}\t${f}`)
}

#!/usr/bin/env node
// Builds every workspace in dependency order.
//
// `npm run build --workspaces` builds in alphabetical order, so on a clean
// checkout (no dist/ yet) a package is compiled before the packages it imports
// — `aql` before `protocol` — and the build fails. This script orders the
// workspaces so each one is built after the workspaces it depends on.
//
// `dependencies` / `peerDependencies` are hard edges. `devDependencies` are soft:
// honored when possible, dropped only to get past a cycle (explainer's tests use
// scorer, and scorer → llm-client → prompt-builder → explainer).

import { readFileSync, readdirSync, existsSync } from "fs"
import { join } from "path"
import { spawnSync } from "child_process"
import { fileURLToPath } from "url"

const root = fileURLToPath(new URL("..", import.meta.url))
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"))

const workspaces = []
for (const pattern of rootPkg.workspaces) {
  const base = pattern.replace(/\/\*$/, "")
  for (const name of readdirSync(join(root, base)).sort()) {
    const dir = `${base}/${name}`
    const pkgPath = join(root, dir, "package.json")
    if (!existsSync(pkgPath)) continue
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
    workspaces.push({ dir, pkg })
  }
}

const byName = new Map(workspaces.map((w) => [w.pkg.name, w]))
const internal = (deps) => Object.keys(deps ?? {}).filter((d) => byName.has(d))
for (const w of workspaces) {
  w.hard = new Set([...internal(w.pkg.dependencies), ...internal(w.pkg.peerDependencies)])
  w.soft = new Set(internal(w.pkg.devDependencies).filter((d) => !w.hard.has(d)))
}

const order = []
const done = new Set()
while (order.length < workspaces.length) {
  const pending = workspaces.filter((w) => !done.has(w.pkg.name))
  const ready = (w, useSoft) =>
    [...w.hard].every((d) => done.has(d)) && (!useSoft || [...w.soft].every((d) => done.has(d)))
  const next = pending.find((w) => ready(w, true)) ?? pending.find((w) => ready(w, false))
  if (!next) {
    console.error(`Dependency cycle among: ${pending.map((w) => w.pkg.name).join(", ")}`)
    process.exit(1)
  }
  order.push(next)
  done.add(next.pkg.name)
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm"
for (const w of order) {
  if (!w.pkg.scripts?.build) continue
  console.log(`\n▶ ${w.pkg.name} (${w.dir})`)
  const result = spawnSync(npm, ["run", "build", "-w", w.dir], { cwd: root, stdio: "inherit", shell: process.platform === "win32" })
  if (result.status !== 0) {
    console.error(`\n✘ build failed in ${w.dir}`)
    process.exit(result.status ?? 1)
  }
}
console.log(`\n✔ built ${order.filter((w) => w.pkg.scripts?.build).length} workspaces`)

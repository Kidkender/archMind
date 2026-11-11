import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

/** Directories that never hold the Express app's own package.json. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "vendor", "public", "docs"])

/** Packages whose presence means the project is not plain Express (it has its own parser). */
const OTHER_FRAMEWORKS = ["@nestjs/core", "@nestjs/common"]

interface PackageJson {
  dependencies?:    Record<string, string>
  devDependencies?: Record<string, string>
}

function readPackageJson(dir: string): PackageJson | null {
  const path = join(dir, "package.json")
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PackageJson
  } catch {
    return null
  }
}

function usesExpress(pkg: PackageJson | null): boolean {
  if (!pkg) return false
  const deps = { ...pkg.devDependencies, ...pkg.dependencies }
  return "express" in deps && !OTHER_FRAMEWORKS.some((name) => name in deps)
}

/**
 * The directory holding the Express app: `root` itself when its package.json
 * depends on `express` (and not on NestJS), otherwise a direct subdirectory
 * that does (`server/`, `backend/`, `api/` in a repo that also holds a
 * front-end). Null when neither does.
 */
export function findExpressRoot(root: string): string | null {
  const own = readPackageJson(root)
  if (usesExpress(own)) return root
  // A NestJS app depends on express too; never look below a project that is NestJS.
  if (own && OTHER_FRAMEWORKS.some((name) => name in { ...own.devDependencies, ...own.dependencies })) return null

  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }
  for (const entry of entries.sort()) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue
    const dir = join(root, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    if (usesExpress(readPackageJson(dir))) return dir
  }
  return null
}

/** True when `root`, or one directory below it, is an Express app. */
export function isExpressProject(root: string): boolean {
  return findExpressRoot(root) !== null
}

import { readdirSync, readFileSync, statSync } from "fs"
import { join, relative } from "path"

/** Directories that hold no server code (or only tests, build output, front-end assets). */
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "coverage", ".git",
  "public", "static", "client", "frontend", "views",
  "test", "tests", "__tests__", "__mocks__", "e2e", "docs",
])

const SOURCE_FILE = /\.(js|cjs|mjs|ts|cts|mts)$/
const EXCLUDED_FILE = /(\.d\.ts|\.(test|spec)\.[cm]?[jt]s|\.min\.js)$/

export interface SourceFile {
  /** Path relative to the project root, with `/` separators. */
  path:    string
  content: string
}

/** JavaScript and TypeScript server files under `root`, relative to it, `/`-separated, sorted. */
export function findSourceFiles(root: string): string[] {
  const out: string[] = []
  walk(root, root, out, 0)
  return out.sort()
}

function walk(root: string, dir: string, out: string[], depth: number): void {
  if (depth > 12) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue
    const abs = join(dir, entry)
    let isDir: boolean
    try {
      isDir = statSync(abs).isDirectory()
    } catch {
      continue
    }
    if (isDir) walk(root, abs, out, depth + 1)
    else if (SOURCE_FILE.test(entry) && !EXCLUDED_FILE.test(entry)) {
      out.push(relative(root, abs).replace(/\\/g, "/"))
    }
  }
}

/** Reads every server file under `root`. Unreadable files are skipped. */
export function readSourceFiles(root: string): SourceFile[] {
  const out: SourceFile[] = []
  for (const path of findSourceFiles(root)) {
    try {
      out.push({ path, content: readFileSync(join(root, path), "utf-8") })
    } catch {
      // unreadable — skip
    }
  }
  return out
}

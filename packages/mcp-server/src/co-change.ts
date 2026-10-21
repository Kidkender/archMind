import { execFileSync } from "child_process"

export interface CoChangeOptions {
  /** Drop files that changed with the target fewer times than this. */
  minCount?: number
  limit?: number
  /** Commits touching more files than this are bulk changes (renames, formatting) and carry no signal. */
  maxFilesPerCommit?: number
}

export interface CoChangedFile {
  file: string
  count: number
  /** count / target_commits */
  ratio: number
}

export interface CoChangeResult {
  target_commits: number
  files: CoChangedFile[]
}

const DEFAULT_MIN_COUNT = 2
const DEFAULT_LIMIT = 15
const DEFAULT_MAX_FILES_PER_COMMIT = 50
const GIT_MAX_BUFFER = 64 * 1024 * 1024

function matchesTarget(file: string, target: string): boolean {
  if (file === target) return true
  const dir = target.endsWith("/") ? target : `${target}/`
  return file.startsWith(dir)
}

/**
 * Files that most often change in the same commit as `target` (a file, or a directory prefix).
 * `commits` is one array of repo-relative paths per commit.
 */
export function computeCoChange(
  commits: readonly (readonly string[])[],
  target: string,
  opts: CoChangeOptions = {}
): CoChangeResult {
  const minCount = opts.minCount ?? 1
  const limit = opts.limit ?? Number.POSITIVE_INFINITY
  const maxFiles = opts.maxFilesPerCommit ?? Number.POSITIVE_INFINITY

  const counts = new Map<string, number>()
  let targetCommits = 0

  for (const files of commits) {
    if (files.length > maxFiles) continue
    if (!files.some((f) => matchesTarget(f, target))) continue
    targetCommits++
    for (const f of new Set(files)) {
      if (matchesTarget(f, target)) continue
      counts.set(f, (counts.get(f) ?? 0) + 1)
    }
  }

  const ranked = [...counts]
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([file, count]) => ({ file, count, ratio: count / targetCommits }))

  return { target_commits: targetCommits, files: ranked }
}

/**
 * File lists of the most recent non-merge commits under `projectRoot`, with paths relative to it.
 * Returns [] when `projectRoot` is not inside a git repository or has no commits.
 */
export function readCommits(projectRoot: string, maxCommits: number): string[][] {
  let out: string
  try {
    out = execFileSync(
      "git",
      ["-C", projectRoot, "log", "--relative", "--name-only", "--no-merges", "--pretty=format:%x00", "-n", String(maxCommits)],
      { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"] }
    )
  } catch {
    return []
  }

  return out
    .split("\0")
    .map((chunk) => chunk.split("\n").filter((line) => line.length > 0))
    .filter((files) => files.length > 0)
}

export { DEFAULT_MIN_COUNT, DEFAULT_LIMIT, DEFAULT_MAX_FILES_PER_COMMIT }

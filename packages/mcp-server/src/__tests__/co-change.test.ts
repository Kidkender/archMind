import { execFileSync } from "child_process"
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { computeCoChange, readCommits } from "../co-change.js"

describe("computeCoChange", () => {
  const commits = [
    ["svc/boss.go", "svc/boss_test.go", "CHANGELOG.md"],
    ["svc/boss.go", "svc/boss_test.go", "CHANGELOG.md", "dto/x.go"],
    ["svc/boss.go", "CHANGELOG.md"],
    ["other/a.go", "CHANGELOG.md"],
  ]

  it("ranks files by how often they changed with the target", () => {
    const r = computeCoChange(commits, "svc/boss.go")
    expect(r.target_commits).toBe(3)
    expect(r.files.map((f) => [f.file, f.count])).toEqual([
      ["CHANGELOG.md", 3],
      ["svc/boss_test.go", 2],
      ["dto/x.go", 1],
    ])
  })

  it("reports the ratio of target commits that included each file", () => {
    const r = computeCoChange(commits, "svc/boss.go")
    expect(r.files[0].ratio).toBe(1)
    expect(r.files[1].ratio).toBeCloseTo(2 / 3)
  })

  it("never lists the target itself", () => {
    expect(computeCoChange(commits, "svc/boss.go").files.map((f) => f.file)).not.toContain("svc/boss.go")
  })

  it("applies minCount", () => {
    const r = computeCoChange(commits, "svc/boss.go", { minCount: 2 })
    expect(r.files.map((f) => f.file)).toEqual(["CHANGELOG.md", "svc/boss_test.go"])
  })

  it("applies limit", () => {
    expect(computeCoChange(commits, "svc/boss.go", { limit: 1 }).files).toHaveLength(1)
  })

  it("treats a directory target as any file under it, excluding files inside it", () => {
    const r = computeCoChange(commits, "svc/")
    expect(r.target_commits).toBe(3)
    expect(r.files.map((f) => f.file)).toEqual(["CHANGELOG.md", "dto/x.go"])
  })

  it("does not match a sibling that only shares a name prefix", () => {
    expect(computeCoChange([["svc2/a.go", "x.go"]], "svc").target_commits).toBe(0)
  })

  it("ignores commits larger than maxFilesPerCommit", () => {
    const big = [["svc/boss.go", ...Array.from({ length: 10 }, (_, i) => `f${i}.go`)]]
    expect(computeCoChange(big, "svc/boss.go", { maxFilesPerCommit: 5 }).target_commits).toBe(0)
  })

  it("returns no files when the target never changed", () => {
    expect(computeCoChange(commits, "nope.go")).toEqual({ target_commits: 0, files: [] })
  })
})

describe("readCommits", () => {
  function git(cwd: string, ...args: string[]): void {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" })
  }

  function makeRepo(): string {
    const dir = join(tmpdir(), `archmind-cochange-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(dir, "api", "svc"), { recursive: true })
    git(dir, "init", "-q")
    writeFileSync(join(dir, "api", "svc", "a.go"), "1")
    writeFileSync(join(dir, "api", "svc", "a_test.go"), "1")
    writeFileSync(join(dir, "README.md"), "1")
    git(dir, "add", ".")
    git(dir, "commit", "-q", "-m", "one")
    writeFileSync(join(dir, "api", "svc", "a.go"), "2")
    writeFileSync(join(dir, "api", "CHANGELOG.md"), "2")
    git(dir, "add", ".")
    git(dir, "commit", "-q", "-m", "two")
    return dir
  }

  it("returns the files of each commit, relative to the given root", () => {
    const dir = makeRepo()
    const commits = readCommits(join(dir, "api"), 100)
    expect(commits.map((c) => [...c].sort())).toEqual([
      ["CHANGELOG.md", "svc/a.go"],
      ["svc/a.go", "svc/a_test.go"],
    ])
  })

  it("returns an empty list outside a git repository", () => {
    const dir = join(tmpdir(), `archmind-nogit-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    expect(readCommits(dir, 100)).toEqual([])
  })
})

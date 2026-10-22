import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { findGoFiles } from "../scanner.js"

function makeProject(): string {
  const dir = join(tmpdir(), `archmind-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(dir, "svc"), { recursive: true })
  writeFileSync(join(dir, "svc", "a.go"), "package svc")
  writeFileSync(join(dir, "svc", "a_test.go"), "package svc")
  return dir
}

describe("findGoFiles", () => {
  it("excludes test files by default", () => {
    expect(findGoFiles(makeProject())).toEqual(["svc/a.go"])
  })

  it("includes test files when asked", () => {
    expect(findGoFiles(makeProject(), { includeTests: true }).sort()).toEqual(["svc/a.go", "svc/a_test.go"])
  })
})

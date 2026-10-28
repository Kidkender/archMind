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

import { isGinProject } from "../scanner.js"

function makeModule(layout: Record<string, string>): string {
  const dir = join(tmpdir(), `archmind-mod-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  for (const [rel, content] of Object.entries(layout)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

const GIN_MOD = "module x\nrequire github.com/gin-gonic/gin v1.9.0\n"

describe("isGinProject", () => {
  it("recognises a go.mod at the root", () => {
    expect(isGinProject(makeModule({ "go.mod": GIN_MOD }))).toBe(true)
  })

  it("recognises a go.mod one directory down, as in a repository that keeps the server in server/", () => {
    expect(isGinProject(makeModule({ "server/go.mod": GIN_MOD, "web/package.json": "{}" }))).toBe(true)
  })

  it("does not look in a skipped directory", () => {
    expect(isGinProject(makeModule({ "vendor/go.mod": GIN_MOD }))).toBe(false)
  })

  it("does not recognise a module that does not use gin", () => {
    expect(isGinProject(makeModule({ "server/go.mod": "module x\nrequire github.com/labstack/echo/v4 v4.0.0\n" }))).toBe(false)
  })

  it("does not take a PHP project for a Go one because of a Go tool in a subdirectory", () => {
    expect(isGinProject(makeModule({ "composer.json": "{}", "tools/go.mod": GIN_MOD }))).toBe(false)
  })
})

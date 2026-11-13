import { describe, test, expect, beforeEach, afterEach } from "@jest/globals"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { isExpressProject, findExpressRoot } from "../detect.js"
import { findSourceFiles, readSourceFiles } from "../scanner.js"
import { createExpressProject, relativePath } from "../project.js"
import { parseExpressProjectAt } from "../adapter.js"

let dir: string

function write(rel: string, content: string): void {
  const abs = join(dir, rel)
  mkdirSync(join(abs, ".."), { recursive: true })
  writeFileSync(abs, content)
}

function packageJson(rel: string, deps: Record<string, string>, devDeps: Record<string, string> = {}): void {
  write(rel, JSON.stringify({ name: "app", dependencies: deps, devDependencies: devDeps }))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "archmind-express-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("isExpressProject / findExpressRoot", () => {
  test("a package.json depending on express is an Express project", () => {
    packageJson("package.json", { express: "^4.19.0" })
    expect(isExpressProject(dir)).toBe(true)
    expect(findExpressRoot(dir)).toBe(dir)
  })

  test("a NestJS project is not, even though it depends on express", () => {
    packageJson("package.json", { express: "^4.19.0", "@nestjs/core": "^10.0.0" })
    expect(isExpressProject(dir)).toBe(false)
  })

  test("an Express app one directory down (server/) is found", () => {
    packageJson("package.json", { react: "^18.0.0" })
    packageJson("server/package.json", { express: "^4.19.0" })
    expect(findExpressRoot(dir)).toBe(join(dir, "server"))
  })

  test("no package.json, a malformed one, or no express dependency is not Express", () => {
    expect(isExpressProject(dir)).toBe(false)
    write("package.json", "{ not json")
    expect(isExpressProject(dir)).toBe(false)
    packageJson("package.json", { koa: "^2.0.0" })
    expect(isExpressProject(dir)).toBe(false)
  })

  test("a Laravel (or Go, Java) root with a Node server in a subdirectory is not Express", () => {
    write("artisan", "")
    packageJson("package.json", { vite: "^5.0.0" })
    packageJson("server/package.json", { express: "^4.19.0" })
    expect(isExpressProject(dir)).toBe(false)
  })

  test("node_modules is never taken for the app", () => {
    packageJson("package.json", { react: "^18.0.0" })
    packageJson("node_modules/package.json", { express: "^4.19.0" })
    expect(isExpressProject(dir)).toBe(false)
  })
})

describe("findSourceFiles / readSourceFiles", () => {
  test("lists JS and TS server files, skipping tests, declarations, build output and front-end folders", () => {
    write("src/app.js", "")
    write("src/routes/user.route.ts", "")
    write("src/routes/user.route.test.ts", "")
    write("src/types.d.ts", "")
    write("src/server.mjs", "")
    write("dist/app.js", "")
    write("node_modules/express/index.js", "")
    write("public/bundle.min.js", "")
    write("tests/app.test.js", "")
    write("README.md", "")

    expect(findSourceFiles(dir)).toEqual(["src/app.js", "src/routes/user.route.ts", "src/server.mjs"])
  })

  test("reads contents with project-relative paths", () => {
    write("src/app.js", "const express = require('express')")
    expect(readSourceFiles(dir)).toEqual([{ path: "src/app.js", content: "const express = require('express')" }])
  })
})

describe("createExpressProject", () => {
  test("loads JavaScript and TypeScript files under their project-relative paths", () => {
    const { files } = createExpressProject([
      { path: "src/app.js", content: "const express = require('express'); const app = express();" },
      { path: "src/routes.ts", content: "import { Router } from 'express'; export const r: Router = Router();" },
    ])
    expect([...files.keys()]).toEqual(["src/app.js", "src/routes.ts"])
    const app = files.get("src/app.js")!
    expect(relativePath(app)).toBe("src/app.js")
    expect(app.getVariableDeclaration("app")).toBeDefined()
    expect(files.get("src/routes.ts")!.getVariableDeclaration("r")).toBeDefined()
  })
})

describe("parseExpressProjectAt", () => {
  test("an app one directory down reports node files relative to the project root", () => {
    packageJson("package.json", { react: "^18.0.0" })
    packageJson("server/package.json", { express: "^4.19.0" })
    write("server/src/app.js", "const app = require('express')(); app.get('/x', function show(req, res) {})")
    const [g] = parseExpressProjectAt(dir)
    expect(g.entrypoint).toBe("GET /x")
    expect(g.nodes.find((n) => n.id === "handler")?.file).toBe("server/src/app.js")
  })

  test("returns no graphs for a project that is not Express", () => {
    packageJson("package.json", { koa: "^2.0.0" })
    write("src/app.js", "")
    expect(parseExpressProjectAt(dir)).toEqual([])
  })
})

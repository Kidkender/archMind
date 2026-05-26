import { describe, test, expect } from "@jest/globals"
import { writeFileSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { parseBootstrap } from "../bootstrap-parser.js"
import { resolveAliasMap, DEFAULT_PROJECT_CONFIG } from "../project-config.js"

const TMP = join(process.cwd(), "__test_bootstrap_tmp__")

function setup(bootstrapContent: string, routeFiles: string[] = []): string {
  const dir = join(TMP, String(Date.now()))
  mkdirSync(join(dir, "bootstrap"), { recursive: true })
  writeFileSync(join(dir, "bootstrap", "app.php"), bootstrapContent, "utf-8")
  for (const rel of routeFiles) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, "<?php", "utf-8")
  }
  return dir
}

function teardown(): void {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
}

const BOOTSTRAP_WITH_ALIASES = `<?php
use Illuminate\\Foundation\\Application;
use Illuminate\\Foundation\\Configuration\\Middleware;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        api: __DIR__.'/../routes/api.php',
        web: __DIR__.'/../routes/web.php',
    )
    ->withMiddleware(function (Middleware $middleware) {
        $middleware->alias([
            'admin' => \\App\\Http\\Middleware\\AdminMiddleware::class,
            'role'  => \\Spatie\\Permission\\Middlewares\\RoleMiddleware::class,
        ]);
    })
    ->create();
`

const BOOTSTRAP_EMPTY_MIDDLEWARE = `<?php
return Application::configure(basePath: dirname(__DIR__))
    ->withMiddleware(function (Middleware $middleware) {
        //
    })
    ->create();
`

describe("parseBootstrap — alias extraction", () => {
  let projectRoot: string

  test("extracts middleware aliases from ->withMiddleware($m->alias([...]))", () => {
    projectRoot = setup(BOOTSTRAP_WITH_ALIASES)
    const { aliasMap } = parseBootstrap(join(projectRoot, "bootstrap", "app.php"), projectRoot)
    expect(aliasMap["admin"]).toBe("App\\Http\\Middleware\\AdminMiddleware")
    expect(aliasMap["role"]).toBe("Spatie\\Permission\\Middlewares\\RoleMiddleware")
    teardown()
  })

  test("returns empty aliasMap when ->withMiddleware body is empty", () => {
    projectRoot = setup(BOOTSTRAP_EMPTY_MIDDLEWARE)
    const { aliasMap } = parseBootstrap(join(projectRoot, "bootstrap", "app.php"), projectRoot)
    expect(Object.keys(aliasMap)).toHaveLength(0)
    teardown()
  })

  test("returns empty result for non-existent file", () => {
    const { aliasMap, routeFiles } = parseBootstrap("/nonexistent/bootstrap/app.php", "/nonexistent")
    expect(aliasMap).toEqual({})
    expect(routeFiles).toEqual([])
  })
})

describe("parseBootstrap — route file detection", () => {
  test("detects api and web route files from ->withRouting(api:..., web:...)", () => {
    const projectRoot = setup(BOOTSTRAP_WITH_ALIASES)
    const { routeFiles } = parseBootstrap(join(projectRoot, "bootstrap", "app.php"), projectRoot)
    expect(routeFiles).toContain("routes/api.php")
    expect(routeFiles).toContain("routes/web.php")
    teardown()
  })

  test("returns empty routeFiles when withRouting is absent", () => {
    const projectRoot = setup(BOOTSTRAP_EMPTY_MIDDLEWARE)
    const { routeFiles } = parseBootstrap(join(projectRoot, "bootstrap", "app.php"), projectRoot)
    expect(routeFiles).toHaveLength(0)
    teardown()
  })
})

describe("resolveAliasMap — version detection", () => {
  test("uses bootstrap/app.php when Kernel.php absent (Laravel 11+)", () => {
    // Create the actual route files so expandRouteFiles can find them on disk
    const projectRoot = setup(BOOTSTRAP_WITH_ALIASES, ["routes/api.php", "routes/web.php"])
    const result = resolveAliasMap(projectRoot, DEFAULT_PROJECT_CONFIG)
    expect(result.aliasMap["admin"]).toBe("App\\Http\\Middleware\\AdminMiddleware")
    expect(result.routeFiles).toContain("routes/api.php")
    teardown()
  })

  test("prefers config.routeFiles when .archmind.json explicitly declares routeFiles", () => {
    const projectRoot = setup(BOOTSTRAP_WITH_ALIASES, ["routes/v2/api.php"])
    // Write .archmind.json with explicit routeFiles — this signals user intent
    writeFileSync(
      join(projectRoot, ".archmind.json"),
      JSON.stringify({ routeFiles: ["routes/v2/api.php"] }),
      "utf-8"
    )
    const customConfig = { ...DEFAULT_PROJECT_CONFIG, routeFiles: ["routes/v2/api.php"] }
    const result = resolveAliasMap(projectRoot, customConfig)
    expect(result.routeFiles).toEqual(["routes/v2/api.php"])
    teardown()
  })

  test("returns empty routeFiles when neither Kernel.php nor bootstrap/app.php exists", () => {
    const result = resolveAliasMap("/nonexistent", DEFAULT_PROJECT_CONFIG)
    expect(result.aliasMap).toEqual({})
    // expandRouteFiles returns [] when the project root doesn't exist
    expect(result.routeFiles).toEqual([])
  })
})

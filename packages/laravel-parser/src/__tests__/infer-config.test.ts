import { describe, test, expect, afterEach } from "@jest/globals"
import { writeFileSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { inferProjectConfig, loadProjectConfig, DEFAULT_PROJECT_CONFIG } from "../project-config.js"

const TMP = join(process.cwd(), "__test_infer_tmp__")

function root(...parts: string[]): string {
  const p = join(TMP, ...parts)
  mkdirSync(p, { recursive: true })
  return p
}

function file(absPath: string, content = "<?php"): void {
  mkdirSync(join(absPath, ".."), { recursive: true })
  writeFileSync(absPath, content, "utf-8")
}

afterEach(() => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ---- namespace inference (composer.json PSR-4) ------------------------------

describe("inferProjectConfig — namespaces", () => {
  test("reads PSR-4 namespaces from composer.json", () => {
    const r = root("ns_basic")
    file(join(r, "composer.json"), JSON.stringify({
      autoload: { "psr-4": { "App\\": "app/", "Domain\\": "src/Domain/" } },
    }))
    const cfg = inferProjectConfig(r)
    expect(cfg.namespaces["App\\"]).toBe("app/")
    expect(cfg.namespaces["Domain\\"]).toBe("src/Domain/")
  })

  test("normalizes namespace trailing backslash and dir trailing slash", () => {
    const r = root("ns_normalize")
    file(join(r, "composer.json"), JSON.stringify({
      autoload: { "psr-4": { "App": "app" } },
    }))
    const cfg = inferProjectConfig(r)
    expect(cfg.namespaces["App\\"]).toBe("app/")
  })

  test("falls back to default when no composer.json", () => {
    const r = root("ns_nocomposer")
    const cfg = inferProjectConfig(r)
    expect(cfg.namespaces).toEqual(DEFAULT_PROJECT_CONFIG.namespaces)
  })

  test("falls back to default when autoload.psr-4 is absent", () => {
    const r = root("ns_nopsr4")
    file(join(r, "composer.json"), JSON.stringify({ name: "laravel/laravel" }))
    const cfg = inferProjectConfig(r)
    expect(cfg.namespaces).toEqual(DEFAULT_PROJECT_CONFIG.namespaces)
  })
})

// ---- route file inference ---------------------------------------------------

describe("inferProjectConfig — routeFiles", () => {
  test("detects all PHP files in routes/", () => {
    const r = root("rf_basic")
    file(join(r, "routes", "api.php"))
    file(join(r, "routes", "web.php"))
    file(join(r, "routes", "channels.php"))
    const cfg = inferProjectConfig(r)
    expect(cfg.routeFiles).toContain("routes/api.php")
    expect(cfg.routeFiles).toContain("routes/web.php")
    expect(cfg.routeFiles).toContain("routes/channels.php")
  })

  test("falls back to default when routes/ directory absent", () => {
    const r = root("rf_nodir")
    const cfg = inferProjectConfig(r)
    expect(cfg.routeFiles).toEqual(DEFAULT_PROJECT_CONFIG.routeFiles)
  })

  test("falls back to default when routes/ directory is empty", () => {
    const r = root("rf_empty")
    mkdirSync(join(r, "routes"), { recursive: true })
    const cfg = inferProjectConfig(r)
    expect(cfg.routeFiles).toEqual(DEFAULT_PROJECT_CONFIG.routeFiles)
  })
})

// ---- policy path inference --------------------------------------------------

describe("inferProjectConfig — policyPaths", () => {
  test("returns app/Policies when it exists", () => {
    const r = root("pp_standard")
    mkdirSync(join(r, "app", "Policies"), { recursive: true })
    const cfg = inferProjectConfig(r)
    expect(cfg.policyPaths).toContain("app/Policies")
  })

  test("returns multiple paths when multiple known dirs exist", () => {
    const r = root("pp_multi")
    mkdirSync(join(r, "app", "Policies"), { recursive: true })
    mkdirSync(join(r, "app", "Http", "Policies"), { recursive: true })
    const cfg = inferProjectConfig(r)
    expect(cfg.policyPaths).toContain("app/Policies")
    expect(cfg.policyPaths).toContain("app/Http/Policies")
  })

  test("falls back to default when no known policy dirs exist", () => {
    const r = root("pp_none")
    const cfg = inferProjectConfig(r)
    expect(cfg.policyPaths).toEqual(DEFAULT_PROJECT_CONFIG.policyPaths)
  })
})

// ---- permission constant file inference -------------------------------------

describe("inferProjectConfig — permissionConstantFiles", () => {
  test("finds Permission.php files in app/", () => {
    const r = root("perm_basic")
    file(join(r, "app", "Enums", "Permission.php"))
    file(join(r, "app", "Enums", "Permissions.php"))
    file(join(r, "app", "Models", "User.php"))
    const cfg = inferProjectConfig(r)
    expect(cfg.permissionConstantFiles).toContain("app/Enums/Permission.php")
    expect(cfg.permissionConstantFiles).toContain("app/Enums/Permissions.php")
    expect(cfg.permissionConstantFiles).not.toContain("app/Models/User.php")
  })

  test("finds Permission files in src/ as well", () => {
    const r = root("perm_src")
    file(join(r, "src", "Permissions.php"))
    const cfg = inferProjectConfig(r)
    expect(cfg.permissionConstantFiles).toContain("src/Permissions.php")
  })

  test("returns empty array when no permission files found", () => {
    const r = root("perm_empty")
    mkdirSync(join(r, "app"), { recursive: true })
    const cfg = inferProjectConfig(r)
    expect(cfg.permissionConstantFiles).toEqual([])
  })
})

// ---- 3-layer merge in loadProjectConfig -------------------------------------

describe("loadProjectConfig — 3-layer merge", () => {
  test("layer 2 inferred namespaces override layer 1 defaults", () => {
    const r = root("merge_l2")
    file(join(r, "composer.json"), JSON.stringify({
      autoload: { "psr-4": { "MyApp\\": "src/" } },
    }))
    file(join(r, "routes", "api.php"))
    const cfg = loadProjectConfig(r)
    // Layer 2 wins over layer 1
    expect(cfg.namespaces["MyApp\\"]).toBe("src/")
    expect(cfg.namespaces["App\\"]).toBeUndefined()
  })

  test("layer 3 .archmind.json overrides layer 2 inferred config", () => {
    const r = root("merge_l3")
    file(join(r, "composer.json"), JSON.stringify({
      autoload: { "psr-4": { "MyApp\\": "src/" } },
    }))
    file(join(r, "routes", "api.php"))
    file(join(r, ".archmind.json"), JSON.stringify({
      namespaces: { "Custom\\": "custom/" },
    }))
    const cfg = loadProjectConfig(r)
    // Layer 3 wins
    expect(cfg.namespaces["Custom\\"]).toBe("custom/")
    expect(cfg.namespaces["MyApp\\"]).toBeUndefined()
  })

  test("partial .archmind.json only overrides specified fields", () => {
    const r = root("merge_partial")
    file(join(r, "composer.json"), JSON.stringify({
      autoload: { "psr-4": { "MyApp\\": "src/" } },
    }))
    file(join(r, "routes", "api.php"))
    file(join(r, ".archmind.json"), JSON.stringify({
      policyPaths: ["app/V2/Policies"],
    }))
    const cfg = loadProjectConfig(r)
    // policyPaths from layer 3
    expect(cfg.policyPaths).toEqual(["app/V2/Policies"])
    // namespaces from layer 2 (inferred)
    expect(cfg.namespaces["MyApp\\"]).toBe("src/")
  })

  test("no composer.json and no .archmind.json falls back to defaults", () => {
    const r = root("merge_default")
    const cfg = loadProjectConfig(r)
    expect(cfg.namespaces).toEqual(DEFAULT_PROJECT_CONFIG.namespaces)
    expect(cfg.routeFiles).toEqual(DEFAULT_PROJECT_CONFIG.routeFiles)
  })
})

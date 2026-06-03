import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { scanGlobalGuards } from "../resolvers/module.resolver.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FIXTURES   = join(__dirname, "fixtures")

describe("scanGlobalGuards — APP_GUARD detection", () => {
  test("detects JwtAuthGuard from APP_GUARD token in module file", () => {
    const guards = scanGlobalGuards(join(FIXTURES, "global-guard"))
    expect(guards).toHaveLength(1)
    expect(guards[0].className).toBe("JwtAuthGuard")
    expect(guards[0].irType).toBe("ir:auth_gate")
  })

  test("returns empty array when no module files exist", () => {
    const guards = scanGlobalGuards(join(FIXTURES, "..", "user-api"))
    // user-api has no *.module.ts files
    expect(guards).toHaveLength(0)
  })

  test("deduplicates when same guard registered multiple times", () => {
    // Only one unique className per project — no duplicates
    const guards = scanGlobalGuards(join(FIXTURES, "global-guard"))
    const names = guards.map(g => g.className)
    expect(new Set(names).size).toBe(names.length)
  })
})

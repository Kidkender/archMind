import { describe, test, expect } from "@jest/globals"
import type { RouteInfo } from "@kidkender/archmind-protocol"
import { detectFindings } from "../detect.js"

const route = (over: Partial<Omit<RouteInfo, "findings">> = {}): Omit<RouteInfo, "findings"> => ({
  entrypoint: "POST /shop/buy",
  method: "POST",
  path: "/shop/buy",
  file: "internal/handler/shop.go",
  line: 1,
  symbol: "ShopHandler.Buy",
  authGates: ["middleware.AuthMiddleware()"],
  authzChecks: [],
  validations: [],
  services: [],
  hasTransaction: false,
  throttled: false,
  framework: "go",
  isPublic: false,
  ...over,
})

const types = (r: Omit<RouteInfo, "findings">, cfg?: Parameters<typeof detectFindings>[1]) =>
  detectFindings(r, cfg).map((f) => f.type)

describe("detectFindings — missing_authorization", () => {
  test("an authenticated mutation with no authz check is reported by default", () => {
    expect(types(route())).toContain("missing_authorization")
  })

  test("an ownership check (authz_check node) clears it", () => {
    expect(types(route({ authzChecks: ["ownership:currentCharacter"] }))).not.toContain("missing_authorization")
  })
})

describe("detectFindings — ignoreFindings config", () => {
  test("drops the finding types the project opted out of", () => {
    expect(types(route(), { ignoreFindings: ["missing_authorization"] })).not.toContain("missing_authorization")
  })

  test("keeps every other finding type", () => {
    const r = route({ authGates: [], authzChecks: [] })
    expect(types(r, { ignoreFindings: ["missing_authorization"] })).toContain("broken_access_control")
  })

  test("an empty list changes nothing", () => {
    expect(types(route(), { ignoreFindings: [] })).toContain("missing_authorization")
  })
})

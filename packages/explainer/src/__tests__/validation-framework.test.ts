import { describe, test, expect } from "@jest/globals"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { explain } from "../index.js"
import { FINDING_TYPES } from "../findings/types.js"

// A validation gate carries authorization only in Laravel (FormRequest::authorize).
// The same route — authenticated, role-checked, input-validated — must not be
// reported as over-authorized, or as delegating authorization from its
// validator, when the validator is a NestJS pipe, a Spring @Valid, a Gin
// binding or an Express celebrate / express-validator.

function route(framework: string | undefined): IntermediateExecutionGraph {
  return {
    entrypoint: "POST /orders",
    method:     "POST",
    path:       "/orders",
    annotations: [],
    ...(framework ? { framework } : {}),
    nodes: [
      { id: "auth",     type: "ir:auth_gate",        symbol: "auth:sanctum" },
      { id: "authz",    type: "ir:authz_check",      symbol: "OrderPolicy::create", args: ["create"] },
      { id: "valid",    type: "ir:validation_gate",  symbol: "StoreOrderRequest" },
      { id: "handler",  type: "ir:business_handler", symbol: "OrderController::store" },
    ],
    edges: [
      { from: "auth",  to: "authz",   relation: "ir:precedes", traceability: "static" },
      { from: "authz", to: "valid",   relation: "ir:precedes", traceability: "static" },
      { from: "valid", to: "handler", relation: "ir:precedes", traceability: "static" },
    ],
  }
}

const types = (g: IntermediateExecutionGraph) => explain(g).map((f) => f.type)

describe("validation gates as authorization layers", () => {
  test.each([["laravel"], [undefined]])("framework %s: a FormRequest counts as an authorization layer", (framework) => {
    const found = types(route(framework))
    expect(found).toContain(FINDING_TYPES.OVER_AUTHORIZED_ROUTE)
    expect(found).toContain(FINDING_TYPES.DELEGATED_VALIDATION)
  })

  test.each([["express"], ["nestjs"], ["springboot"], ["gin"]])("framework %s: input validation is not an authorization layer", (framework) => {
    const found = types(route(framework))
    expect(found).not.toContain(FINDING_TYPES.OVER_AUTHORIZED_ROUTE)
    expect(found).not.toContain(FINDING_TYPES.DELEGATED_VALIDATION)
  })
})

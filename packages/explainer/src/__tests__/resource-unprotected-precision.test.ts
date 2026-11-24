import { describe, test, expect } from "@jest/globals"
import { detectResourceMismatch } from "../pattern-detectors/resource-mismatch.js"
import { detectDelegatedValidation } from "../pattern-detectors/delegated-validation.js"
import { extractValidationGateFacts } from "../fact-extraction/validation.js"
import { FINDING_TYPES } from "../findings/types.js"
import type { IntermediateExecutionGraph, ExecutionNode, ExecutionEdge } from "@kidkender/archmind-protocol"

const ctrl: ExecutionNode = { id: "ctrl", type: "ir:business_handler", symbol: "VaultController::show", role: "handler" }
const res: ExecutionNode  = { id: "res_vault", type: "ir:resource", symbol: "Vault", role: "accessed_resource" }
const auth: ExecutionNode = { id: "mw_auth", type: "ir:auth_gate", symbol: "auth:sanctum", role: "authentication" }
const accesses: ExecutionEdge = { from: "ctrl", to: "res_vault", relation: "ir:accesses", traceability: "static" }

function graph(method: string, extra: ExecutionNode[] = [], extraEdges: ExecutionEdge[] = []): IntermediateExecutionGraph {
  return {
    entrypoint: `${method} /vaults/{vault}`,
    method,
    path: "/vaults/{vault}",
    nodes: [ctrl, res, ...extra],
    edges: [accesses, ...extraEdges],
    annotations: [],
  }
}

const unprotected = (g: IntermediateExecutionGraph) =>
  detectResourceMismatch(g).filter((f) => f.type === FINDING_TYPES.RESOURCE_UNPROTECTED)

describe("resource_unprotected precision", () => {
  test("public route reading a model by ID → CRITICAL", () => {
    const f = unprotected(graph("GET"))
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe("CRITICAL")
  })

  test("authenticated read with no authorization → HIGH (IDOR among users), not CRITICAL", () => {
    const f = unprotected(graph("GET", [auth]))
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe("HIGH")
    expect(f[0]!.summary).toContain("any logged-in user")
  })

  test("any authorization on the route (helper, service rule, FormRequest) → no claim", () => {
    const helper: ExecutionNode = { id: "authz", type: "ir:authz_check", symbol: "checkPermission(vault-view)", role: "authorization" }
    expect(unprotected(graph("GET", [auth, helper]))).toHaveLength(0)
  })

  test("authenticated mutation without authorization is left to missing_authorization (no duplicate)", () => {
    expect(unprotected(graph("DELETE", [auth]))).toHaveLength(0)
  })

  test("provable mismatch is still reported", () => {
    const other: ExecutionNode = { id: "res_post", type: "ir:resource", symbol: "Post", role: "accessed_resource" }
    const pol: ExecutionNode   = { id: "pol", type: "ir:authz_check", symbol: "PostPolicy::view", role: "authorization" }
    const g = graph("GET", [auth, other, pol], [{ from: "pol", to: "res_post", relation: "ir:authorizes", traceability: "semantic" }])
    expect(detectResourceMismatch(g).some((f) => f.type === FINDING_TYPES.RESOURCE_MISMATCH)).toBe(true)
  })
})

describe("delegated_validation on public-by-design routes", () => {
  function frGraph(path: string): IntermediateExecutionGraph {
    return {
      entrypoint: `POST ${path}`,
      method: "POST",
      path,
      nodes: [{ id: "fr", type: "ir:validation_gate", symbol: "SignupRequest::authorize", role: "validation_only" }],
      edges: [],
      annotations: [],
    }
  }
  const run = (g: IntermediateExecutionGraph) => detectDelegatedValidation(extractValidationGateFacts(g), [], g)

  test.each(["/api/v1/signup", "/client/password/email", "/api/v1/login/precheck", "/webhooks/stripe"])(
    "%s → INFO",
    (path) => {
      expect(run(frGraph(path))[0]!.severity).toBe("INFO")
    },
  )

  test("an ordinary public mutation stays MEDIUM", () => {
    expect(run(frGraph("/api/v1/invoices"))[0]!.severity).toBe("MEDIUM")
  })
})

import { explain } from "../index.js"

describe("missing_authorization on self-service routes", () => {
  function mutation(path: string, extra: ExecutionNode[] = []): IntermediateExecutionGraph {
    return {
      entrypoint: `PATCH ${path}`,
      method: "PATCH",
      path,
      nodes: [auth, { id: "ctrl", type: "ir:business_handler", symbol: "PreferencesController::update", role: "handler" }, ...extra],
      edges: [{ from: "mw_auth", to: "ctrl", relation: "ir:precedes", traceability: "static" }],
      annotations: [],
    }
  }
  const types = (g: IntermediateExecutionGraph) => explain(g).map((f) => f.type)

  test.each(["/preferences/toggle-dark-mode", "/my-account/shortcuts", "/api/me/password", "/user/profile"])(
    "%s → not reported (acting on the caller's own record)",
    (path) => {
      expect(types(mutation(path))).not.toContain(FINDING_TYPES.MISSING_AUTHORIZATION)
    },
  )

  test("a self-service path that loads another record by ID is still reported", () => {
    const g = mutation("/profile/{user}", [{ id: "res_user", type: "ir:resource", symbol: "User", role: "accessed_resource" }])
    g.edges.push({ from: "ctrl", to: "res_user", relation: "ir:accesses", traceability: "static" })
    expect(types(g)).toContain(FINDING_TYPES.MISSING_AUTHORIZATION)
  })

  test("an ordinary mutation is still reported", () => {
    expect(types(mutation("/settings/webhooks/create"))).toContain(FINDING_TYPES.MISSING_AUTHORIZATION)
  })

  test("a route whose handler method doesn't exist reports nothing", () => {
    const g = mutation("/artists/{artist}/songs/{id}")
    g.annotations.push({ type: "handler_not_found", description: "no method", nodes: ["ctrl"] })
    expect(explain(g)).toEqual([])
  })
})

describe("signed URLs and more self-service paths", () => {
  test("a signed URL protects a public record read", () => {
    const signed: ExecutionNode = { id: "mw_signed", type: "signature_check", symbol: "signed", role: "authentication" }
    expect(unprotected(graph("GET", [signed]))).toHaveLength(0)
  })
  test.each(["/api/v1/settings/enable_two_factor", "/api/broadcasting/auth"])("%s → self-service", (path) => {
    const g: IntermediateExecutionGraph = {
      entrypoint: `POST ${path}`, method: "POST", path,
      nodes: [auth, { id: "ctrl", type: "ir:business_handler", symbol: "X::y", role: "handler" }],
      edges: [], annotations: [],
    }
    expect(explain(g).map((f) => f.type)).not.toContain(FINDING_TYPES.MISSING_AUTHORIZATION)
  })
})

import { detectExposedReadEndpoint } from "../pattern-detectors/exposed-read-endpoint.js"

describe("exposed_read_endpoint on public-by-design routes", () => {
  function publicRead(path: string): IntermediateExecutionGraph {
    return {
      entrypoint: `GET ${path}`, method: "GET", path,
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "SsoController::acs", role: "handler" },
        { id: "svc", type: "ir:service_call", symbol: "Saml2Service::processAcs", role: "service" },
      ],
      edges: [{ from: "ctrl", to: "svc", relation: "calls", traceability: "semantic" }],
      annotations: [],
    }
  }
  test.each(["/saml2/acs", "/auth/oidc/callback", "/register/invite/{token}"])("%s → INFO", (path) => {
    expect(detectExposedReadEndpoint(publicRead(path))[0]?.severity).toBe("INFO")
  })
  test("an ordinary public read stays MEDIUM", () => {
    expect(detectExposedReadEndpoint(publicRead("/api/invoices"))[0]?.severity).toBe("MEDIUM")
  })
})

import type { ExecutionNode } from "@archmind/protocol"

// Maps raw Laravel middleware strings → semantic ExecutionNodes.
// This is the bridge between framework syntax and ontology primitives.
//
// Only deterministic mappings — no dynamic resolution.

interface MiddlewareMapping {
  type:   string
  role:   string
  args?:  string[]
}

function mapMiddleware(raw: string): MiddlewareMapping {
  // auth:sanctum, auth:api, auth:web
  if (/^auth:/.test(raw)) {
    return { type: "authentication_gate", role: "authentication" }
  }

  // permission:TASK_UPDATE, permission:TASK_VIEW|TASK_UPDATE
  const permMatch = raw.match(/^permission:(.+)$/)
  if (permMatch) {
    return {
      type: "authorization_check",
      role: "authorization",
      args: permMatch[1].split("|"),
    }
  }

  // throttle:60,1
  if (/^throttle:/.test(raw)) {
    return { type: "rate_limiter", role: "rate_limiting" }
  }

  // signed
  if (raw === "signed") {
    return { type: "signature_check", role: "authentication" }
  }

  // verified (email verification)
  if (raw === "verified") {
    return { type: "email_verification", role: "authentication" }
  }

  // Class-based middleware — use short class name as symbol
  if (raw.includes("\\") || /^[A-Z]/.test(raw)) {
    return { type: "middleware", role: "middleware", args: [raw] }
  }

  return { type: "middleware", role: "middleware" }
}

export function middlewareToNode(raw: string, index: number): ExecutionNode {
  const mapping = mapMiddleware(raw.trim())
  const shortName = raw.split("\\").pop()?.replace(/::class$/, "") ?? raw

  return {
    id:     `mw_${index}_${shortName.toLowerCase().replace(/[^a-z0-9]/g, "_")}`,
    type:   mapping.type,
    symbol: shortName,
    role:   mapping.role,
    args:   mapping.args ?? (raw !== shortName ? [raw] : undefined),
  }
}

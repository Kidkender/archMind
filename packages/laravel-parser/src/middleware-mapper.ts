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

/**
 * Classify a resolved FQCN by class-name heuristics.
 * Used when a middleware alias has been resolved to a concrete class.
 */
function classifyFqcn(fqcn: string): MiddlewareMapping {
  const short = fqcn.split("\\").pop() ?? fqcn
  if (/Authenticate|Guard/.test(short)) {
    return { type: "authentication_gate", role: "authentication" }
  }
  if (/Permission|Role|Authorize|CheckAccess|HasRole|EnsureRole|EnsureUser/.test(short)) {
    return { type: "authorization_check", role: "authorization" }
  }
  if (/Throttle|RateLimit/.test(short)) {
    return { type: "rate_limiter", role: "rate_limiting" }
  }
  return { type: "middleware", role: "middleware" }
}

/**
 * Build an ExecutionNode from an alias-resolved middleware.
 * Used when kernel-parser has resolved the alias to a concrete FQCN.
 */
export function resolvedMiddlewareToNode(
  raw: string,     // original alias string (for stable id generation)
  fqcn: string,    // resolved fully-qualified class name
  args: string[],  // parsed args from alias (e.g. "role:admin" → ["admin"])
  index: number
): ExecutionNode {
  const mapping  = classifyFqcn(fqcn)
  const short    = fqcn.split("\\").pop() ?? fqcn
  const file     = fqcn.includes("\\")
    ? fqcn.replace(/^App\\/, "app/").replace(/\\/g, "/") + ".php"
    : undefined
  const idBase   = raw.toLowerCase().replace(/[^a-z0-9]/g, "_")

  return {
    id:   `mw_${index}_${idBase}`,
    type: mapping.type,
    symbol: short,
    role: mapping.role,
    ...(file              ? { file }         : {}),
    ...(args.length > 0   ? { args }         : {}),
  }
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

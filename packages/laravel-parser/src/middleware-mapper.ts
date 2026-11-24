import type { ExecutionNode } from "@kidkender/archmind-protocol"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import { DEFAULT_PROJECT_CONFIG, fqcnToPath } from "./project-config.js"

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
  // Guest-only middleware (RedirectIfAuthenticated, the `guest` alias) is the
  // opposite of authentication — the route is for logged-OUT users (login,
  // register, password reset). It must never read as an auth gate.
  if (/RedirectIfAuthenticated|Guest/.test(short)) {
    return { type: IR_NODE_TYPES.UNKNOWN_MIDDLEWARE, role: "guest" }
  }
  // Signed-URL validation (Illuminate ValidateSignature, app subclasses)
  if (/ValidateSignature|SignedUrl|ValidateSigned/.test(short)) {
    return { type: "signature_check", role: "authentication" }
  }
  // "Authorize…" contains "Auth" — check it before the authentication patterns
  if (/Authoriz/.test(short)) {
    return { type: IR_NODE_TYPES.AUTHZ_CHECK, role: "authorization" }
  }
  if (/Authenticat|Guard|^Auth|Auth(Middleware)?$|Jwt|JWT|TokenAuth|CheckLogin|RequireLogin|LoggedIn/.test(short)) {
    return { type: IR_NODE_TYPES.AUTH_GATE, role: "authentication" }
  }
  if (/Permission|Role|CheckAccess|HasRole|EnsureRole|EnsureUser|Admin|Owner/.test(short)) {
    return { type: IR_NODE_TYPES.AUTHZ_CHECK, role: "authorization" }
  }
  if (/Throttle|RateLimit/.test(short)) {
    return { type: "rate_limiter", role: "rate_limiting" }
  }
  // Resolved to a concrete class, but it doesn't match a known category —
  // an honest "don't know" instead of guessing auth_gate from the mere presence
  // of a middleware node (see IR v1.5 semantic-fidelity plan, Phase 1).
  return { type: IR_NODE_TYPES.UNKNOWN_MIDDLEWARE, role: "unknown" }
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
    ? (fqcnToPath(fqcn, DEFAULT_PROJECT_CONFIG.namespaces) ?? undefined)
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
    return { type: IR_NODE_TYPES.AUTH_GATE, role: "authentication" }
  }

  // permission:TASK_UPDATE, permission:TASK_VIEW|TASK_UPDATE
  const permMatch = raw.match(/^permission:(.+)$/)
  if (permMatch) {
    return {
      type: IR_NODE_TYPES.AUTHZ_CHECK,
      role: "authorization",
      args: permMatch[1].split("|"),
    }
  }

  // Laravel's built-in aliases, recognised even without a Kernel.php to resolve
  // them (Laravel 11+ registers them in the framework, not in the app):
  //   auth / auth.basic        → Authenticate
  //   can:update,post          → Authorize (policy / Gate ability)
  //   role:, ability:, abilities: (spatie, sanctum token abilities)
  //   guest                    → RedirectIfAuthenticated (logged-out only)
  if (raw === "auth" || raw === "auth.basic") {
    return { type: IR_NODE_TYPES.AUTH_GATE, role: "authentication" }
  }
  const abilityMatch = raw.match(/^(can|role|roles|ability|abilities|role_or_permission):(.+)$/)
  if (abilityMatch) {
    return { type: IR_NODE_TYPES.AUTHZ_CHECK, role: "authorization", args: abilityMatch[2]!.split(/[|,]/) }
  }
  if (raw === "guest") {
    return { type: IR_NODE_TYPES.UNKNOWN_MIDDLEWARE, role: "guest" }
  }

  // throttle:60,1
  if (/^throttle:/.test(raw)) {
    return { type: "rate_limiter", role: "rate_limiting" }
  }

  // signed, signed:relative — a signed URL: only holders of the link get in
  if (raw === "signed" || /^signed:/.test(raw)) {
    return { type: "signature_check", role: "authentication" }
  }

  // verified (email verification)
  if (raw === "verified") {
    return { type: "email_verification", role: "authentication" }
  }

  // Class-based middleware — classify by class name, the same heuristics as an
  // alias resolved to its FQCN. Defaulting every class to auth_gate made
  // session/locale/domain middleware (invoiceninja's SessionDomains) read as
  // "authenticated" on public routes such as password reset.
  if (raw.includes("\\") || /^[A-Z]/.test(raw)) {
    const fqcn = raw.replace(/::class$/, "")
    return { ...classifyFqcn(fqcn), args: [raw] }
  }

  // Bare, unresolved string with no class/keyword signal (e.g. a group name like
  // "api" that couldn't be resolved to its concrete middleware list) — an honest
  // "don't know" instead of defaulting every unrecognized string to auth_gate,
  // which was the source of the koel false-positive (IR v1.5 plan, Phase 1).
  return { type: IR_NODE_TYPES.UNKNOWN_MIDDLEWARE, role: "unknown" }
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

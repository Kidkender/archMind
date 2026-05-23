import type { QueryContext, QueryFocus } from "./types.js"
export type { QueryContext, QueryFocus }

// P3.5 trade-off: coarse focus only (auth/validation/runtime/all).
// Finer per-finding boosting (matching summary tokens) deferred to benchmarks.

// Auth is checked first — "authorization request" must → auth, not validation.
const AUTH_RE        = /\b(auth|authoriz|permission|policy|middleware|guard|access|role|privilege)/i
const VALIDATION_RE  = /\b(validat|form.?request)/i
const RUNTIME_RE     = /\b(runtime|inject|container)/i
const TRANSACTION_RE = /\b(transaction|commit|rollback|atomic|dispatch.*before|event.*commit|notification.*fail)/i
const ISOLATION_RE   = /\b(tenant|isolation|cross.tenant|multi.tenant|scope|unscoped|data.leak)/i

export function classifyQuery(query: string): QueryContext {
  const trimmed = query.trim()
  if (!trimmed) return { raw: query, focus: "all" }

  if (TRANSACTION_RE.test(trimmed)) return { raw: query, focus: "transaction" }
  if (ISOLATION_RE.test(trimmed))   return { raw: query, focus: "isolation" }
  if (AUTH_RE.test(trimmed))        return { raw: query, focus: "auth" }
  if (VALIDATION_RE.test(trimmed))  return { raw: query, focus: "validation" }
  if (RUNTIME_RE.test(trimmed))     return { raw: query, focus: "runtime" }

  return { raw: query, focus: "all" }
}

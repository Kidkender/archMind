import type { Finding } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import type { QueryFocus } from "./types.js"

const FOCUS_FINDING_TYPES: Partial<Record<Exclude<QueryFocus, "all">, ReadonlySet<string>>> = {
  auth: new Set([
    FINDING_TYPES.DUPLICATE_AUTHORIZATION,
    FINDING_TYPES.MISSING_AUTHORIZATION,
    FINDING_TYPES.MISSING_POLICY,
    FINDING_TYPES.PRIVILEGE_HIERARCHY_PRESENT,
    FINDING_TYPES.DOUBLE_PERMISSION_CHECK,
  ]),
  validation:   new Set([FINDING_TYPES.DELEGATED_VALIDATION]),
  runtime:      new Set([FINDING_TYPES.HIDDEN_RUNTIME_DEPENDENCY, FINDING_TYPES.RUNTIME_CONSUMER_TRACE]),
  transaction:  new Set([FINDING_TYPES.EVENT_BEFORE_COMMIT]),
  isolation:    new Set([FINDING_TYPES.MISSING_TENANT_SCOPE]),
}

export function prioritizeByFocus(findings: Finding[], focus: QueryFocus): Finding[] {
  if (focus === "all") return findings
  const relevant = FOCUS_FINDING_TYPES[focus]
  if (!relevant) return findings
  const primary = findings.filter(f => relevant.has(f.type))
  const secondary = findings.filter(f => !relevant.has(f.type))
  return [...primary, ...secondary]
}

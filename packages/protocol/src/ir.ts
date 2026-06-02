// Semantic IR — framework-agnostic vocabulary for ArchMind execution graphs.
// This is the target type system. Laravel-specific strings in graph.ts are
// the current source of truth; migration happens adapter-by-adapter.
//
// Spec: research/semantic-ir/spec.md

export const IR_VERSION = "1.0"

// ---------------------------------------------------------------------------
// IR Node Types
// ---------------------------------------------------------------------------

export const IR_NODE_TYPES = {
  // HTTP Request domain
  ENTRYPOINT:          "ir:entrypoint",
  AUTH_GATE:           "ir:auth_gate",
  AUTHZ_CHECK:         "ir:authz_check",
  BUSINESS_HANDLER:    "ir:business_handler",
  VALIDATION_GATE:     "ir:validation_gate",
  SERVICE_CALL:        "ir:service_call",
  PERMISSION_CONSTANT: "ir:permission_constant",

  // Runtime context domain
  RUNTIME_INJECT:      "ir:runtime_inject",
  RUNTIME_CONSUME:     "ir:runtime_consume",
  TENANT_CONTEXT:      "ir:tenant_context",

  // Data access domain
  SCOPED_QUERY:        "ir:scoped_query",
  UNSCOPED_QUERY:      "ir:unscoped_query",

  // Transaction domain
  TXN_BOUNDARY:        "ir:txn_boundary",
  TXN_WRITE:           "ir:txn_write",
  TXN_ESCAPE:          "ir:txn_escape",
} as const

export type IRNodeType = typeof IR_NODE_TYPES[keyof typeof IR_NODE_TYPES]

// ---------------------------------------------------------------------------
// IR Edge Relations
// ---------------------------------------------------------------------------

export const IR_EDGE_RELATIONS = {
  PRECEDES:          "ir:precedes",
  CALLS:             "ir:calls",
  GUARDS:            "ir:guards",
  VALIDATES:         "ir:validates",
  INJECTS:           "ir:injects",
  CHECKS_PERMISSION: "ir:checks_permission",
  ACCESSES:          "ir:accesses",
  WRAPS:             "ir:wraps",
  ESCAPES:           "ir:escapes",
} as const

export type IREdgeRelation = typeof IR_EDGE_RELATIONS[keyof typeof IR_EDGE_RELATIONS]

// ---------------------------------------------------------------------------
// IR Annotation Types (detections — run on IR, framework-agnostic)
// ---------------------------------------------------------------------------

export const IR_ANNOTATION_TYPES = {
  AUTH_GAP:      "ir:auth_gap",
  AUTHZ_GAP:     "ir:authz_gap",
  MISSING_POLICY: "ir:missing_policy",
  DOUBLE_CHECK:  "ir:double_check",
  TXN_ESCAPE:    "ir:txn_escape",
  MISSING_TXN:   "ir:missing_txn",
  ISOLATION_RISK: "ir:isolation_risk",
} as const

export type IRAnnotationType = typeof IR_ANNOTATION_TYPES[keyof typeof IR_ANNOTATION_TYPES]

// ---------------------------------------------------------------------------
// Laravel adapter mapping — legacy type → IR type
// Used during migration to normalise graphs emitted before full IR adoption.
// ---------------------------------------------------------------------------

export const LARAVEL_TO_IR: Record<string, IRNodeType> = {
  // Auth / validation domain
  "authentication_gate":  IR_NODE_TYPES.AUTH_GATE,
  "authorization_check":  IR_NODE_TYPES.AUTHZ_CHECK,
  "controller_action":    IR_NODE_TYPES.BUSINESS_HANDLER,
  "form_request":         IR_NODE_TYPES.VALIDATION_GATE,
  "service_call":         IR_NODE_TYPES.SERVICE_CALL,
  "permission":           IR_NODE_TYPES.PERMISSION_CONSTANT,
  "middleware":           IR_NODE_TYPES.AUTH_GATE,       // default; middleware-mapper classifies more specifically
  "policy":               IR_NODE_TYPES.AUTHZ_CHECK,
  "runtime_injection":    IR_NODE_TYPES.RUNTIME_INJECT,

  // Transaction domain
  "transaction_boundary": IR_NODE_TYPES.TXN_BOUNDARY,
  "transactional_write":  IR_NODE_TYPES.TXN_WRITE,
  "transaction_escape":   IR_NODE_TYPES.TXN_ESCAPE,

  // Isolation domain
  "unscoped_query":       IR_NODE_TYPES.UNSCOPED_QUERY,
  "tenant_scoped_query":  IR_NODE_TYPES.SCOPED_QUERY,
}

// Normalise a node type string: if it's a legacy Laravel type, return the IR equivalent.
// If it's already an IR type (starts with "ir:"), return as-is.
// Unknown types pass through unchanged.
export function toIRNodeType(type: string): string {
  if (type.startsWith("ir:")) return type
  return LARAVEL_TO_IR[type] ?? type
}

// ---------------------------------------------------------------------------
// IR conformance check
// ---------------------------------------------------------------------------

const IR_TYPE_SET = new Set<string>(Object.values(IR_NODE_TYPES))

export function isIRNodeType(type: string): type is IRNodeType {
  return IR_TYPE_SET.has(type)
}

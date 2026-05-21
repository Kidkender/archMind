/**
 * Structural schema for ontology primitives.
 *
 * Design principle: validate STRUCTURE only, not semantic correctness.
 * - `type` is string, not enum — ontology is being discovered, not predefined.
 * - `semantic_primitives` is string[], not locked to approved list.
 * - Confidence uses enum — precise enough to be useful, not so precise it requires calibration.
 */

// ─── Confidence & Evidence ────────────────────────────────────────────────────

export enum Confidence {
  HIGH    = "HIGH",
  MEDIUM  = "MEDIUM",
  LOW     = "LOW",
  UNKNOWN = "UNKNOWN",
}

export enum EvidenceType {
  STATIC     = "STATIC",      // derivable from AST alone
  SEMANTIC   = "SEMANTIC",    // requires ontology / framework knowledge
  RUNTIME    = "RUNTIME",     // requires runtime traces
  INFERRED   = "INFERRED",    // probabilistic / heuristic
}

// ─── Execution Node ───────────────────────────────────────────────────────────

export interface ExecutionNode {
  id:       string    // unique within a trace, e.g. "resolve_tenant"
  type:     string    // free-form: "middleware", "controller", "policy", etc.
  symbol:   string    // fully-qualified symbol, e.g. "ResolveTenant::handle"
  file?:    string    // relative path from project root
  args?:    string[]  // relevant arguments, e.g. ["task.update"]
  role?:    string    // semantic role hint, e.g. "auth_layer_1"
  metadata?: Record<string, unknown>
}

// ─── Execution Edge ───────────────────────────────────────────────────────────

export enum EdgeTraceability {
  STATIC       = "static",       // AST-derivable
  SEMANTIC     = "semantic",     // requires framework ontology
  RUNTIME      = "runtime",      // requires runtime traces
  PROBABILISTIC = "probabilistic", // inference / heuristic
}

export interface ExecutionEdge {
  from:         string              // ExecutionNode.id
  to:           string              // ExecutionNode.id
  relation:     string              // free-form: "next_middleware", "policy_check", etc.
  traceability: EdgeTraceability
  mechanism?:   string              // e.g. "$this->authorize('update', $task)"
  side_effect?: string              // e.g. "injects app('tenant')"
  description?: string
}

// ─── Annotation ───────────────────────────────────────────────────────────────

export interface Annotation {
  type:        string    // free-form: "overlap", "bug", "implicit_contract", etc.
  nodes?:      string[]  // ExecutionNode.ids involved
  description: string
  severity?:   "critical" | "high" | "medium" | "low" | "info"
  fix?:        string
  confidence?: Confidence
  evidence?:   string[]  // human-readable evidence statements
}

// ─── Semantic Primitive reference ────────────────────────────────────────────

export interface PrimitiveRef {
  name:       string          // e.g. "RuntimeInjection", "ExecutionOverlap"
  confidence: Confidence
  evidence:   string[]        // why this primitive was identified here
}

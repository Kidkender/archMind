/**
 * Structural schema for golden trace files.
 *
 * Golden traces are the ground truth execution paths used for benchmarking.
 * YAML files in research/golden-traces/ must conform to this structure.
 */

import type { ExecutionNode, ExecutionEdge, Annotation, PrimitiveRef } from "../ontology/primitives"

export interface GoldenTrace {
  // ── Identity ────────────────────────────────────────────────────────────────
  id:          string    // e.g. "LARAVEL-AUTH-001"
  framework:   string    // e.g. "laravel"
  entrypoint:  string    // e.g. "PUT /tasks/{id}"
  source_project: string

  // ── Graph ───────────────────────────────────────────────────────────────────
  nodes:       ExecutionNode[]
  edges:       ExecutionEdge[]
  annotations: Annotation[]

  // ── Benchmark metadata ──────────────────────────────────────────────────────
  semantic_primitives?: PrimitiveRef[]

  contract?: {
    enforced_by: string
    risk?:       string
  }
}

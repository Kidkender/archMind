/**
 * Structural schema for semantic pain case files.
 *
 * Pain cases in research/semantic-pains/ must have frontmatter
 * conforming to this structure.
 */

import type { } from "../ontology/primitives"

export interface PainCase {
  // ── Identity ────────────────────────────────────────────────────────────────
  id:          string    // e.g. "LARAVEL-AUTH-001" — format: FRAMEWORK-CATEGORY-SEQ
  framework:   string
  category:    string    // free-form: "execution-overlap", "runtime-dependency", etc.
  difficulty:  "low" | "medium" | "high" | "very-high"

  // ── Execution context ───────────────────────────────────────────────────────
  entrypoint:  string
  source_project: string

  // ── Benchmark data ──────────────────────────────────────────────────────────
  expected_nodes:       string[]   // ExecutionNode.symbol values
  expected_edges?:      string[]   // free-form descriptions
  semantic_primitives:  string[]   // PrimitiveRef.name values — validated as strings only

  // ── Links ───────────────────────────────────────────────────────────────────
  golden_trace:  string   // relative path to .yaml file

  // ── Optional flags ──────────────────────────────────────────────────────────
  overlap_detected?:  boolean
  bug_detected?:      boolean
  runtime_contract?:  boolean
  pattern?:           string
}

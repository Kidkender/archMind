import type { IntermediateExecutionGraph } from "./graph.js"

// RouteTrace = execution graph for one route + benchmark metadata
export interface RouteTrace extends IntermediateExecutionGraph {
  framework:      string   // "laravel"
  source_file:    string   // file the route was extracted from
  source_project?: string
}

// ExtractionResult wraps output from the parser with confidence info
export interface ExtractionResult {
  traces:   RouteTrace[]
  errors:   ExtractionError[]
  stats: {
    routes_found:     number
    routes_extracted: number
    skipped_dynamic:  number  // routes with dynamic config(), variable middleware, etc.
  }
}

export interface ExtractionError {
  file:    string
  line?:   number
  message: string
}

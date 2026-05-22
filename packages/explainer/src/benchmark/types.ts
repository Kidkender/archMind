export interface ExplainerTraceSnapshot {
  trace_id: string
  recall: number
  node_coverage: number
  finding_count: number
  expected_count: number
  hits: string[]
  misses: string[]
}

export interface ExplainerBenchmarkSnapshot {
  run_at: string
  traces: ExplainerTraceSnapshot[]
  avg_recall: number
}

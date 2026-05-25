// Runtime intelligence types — OTel spans, sessions, findings.

export interface OtelSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Record<string, string | number | boolean>
  status?: { code: number; message?: string }
}

export interface TraceSession {
  sessionId: string
  entrypoint: string
  durationMs: number
  spans: OtelSpan[]
  recordedAt: string
  framework?: string
  serviceVersion?: string
}

export type RuntimeEdgeRelation =
  | "executed_query"
  | "dispatched_job"
  | "cache_miss"
  | "cache_hit"
  | "http_call"
  | "event_emitted"

export interface RuntimeFinding {
  type: string
  severity: "critical" | "high" | "medium" | "low"
  spanIds: string[]
  nodeIds: string[]
  evidence: string
  count?: number
  metadata?: Record<string, unknown>
}

export interface CorrelatedSpan {
  span: OtelSpan
  nodeId: string | null
  strategy: "exact_symbol" | "namespace_function" | "middleware_name" | "partial_symbol" | "unmatched"
  confidence: "exact" | "high" | "partial" | "none"
}

export interface CorrelatedSession {
  session: TraceSession
  correlations: CorrelatedSpan[]
  correlationRate: number
  infraSpans: OtelSpan[]
}

export type TracePattern = "auth" | "event" | "transaction" | "isolation" | "request"

export interface AuthTraceEntry {
  entrypoint: string
  auth_gates: string[]        // middleware symbols
  authz_checks: string[]      // policy symbols
  validation_gates: string[]  // form_request symbols
  resources: string[]         // ir:resource symbols
  unprotected_resources: string[]
  has_auth: boolean
}

export interface EventTraceEntry {
  entrypoint: string
  dispatched_events: string[]   // txn_escape node symbols
  inside_transaction: boolean
}

export interface TransactionTraceEntry {
  entrypoint: string
  boundaries: string[]    // txn_boundary symbols
  writes: string[]        // txn_write symbols
  escapes: string[]       // txn_escape symbols (side-effects leaving txn)
}

export interface IsolationTraceEntry {
  entrypoint: string
  unscoped_queries: string[]
  unscoped_writes: string[]
  has_tenant_context: boolean
}

export interface RequestTraceEntry {
  entrypoint: string
  execution_path: Array<{
    nodeId: string
    symbol: string
    type: string
    role: string
  }>
}

export type TraceEntry =
  | AuthTraceEntry
  | EventTraceEntry
  | TransactionTraceEntry
  | IsolationTraceEntry
  | RequestTraceEntry

export interface AuthTraceSummary {
  routes_with_auth: number
  routes_without_auth: number
  routes_with_unprotected_resources: number
}

export interface EventTraceSummary {
  routes_dispatching_events: number
  routes_with_unsafe_dispatch: number  // dispatch outside transaction
}

export interface TransactionTraceSummary {
  routes_with_transactions: number
  routes_with_escapes: number
}

export interface IsolationTraceSummary {
  routes_with_unscoped_queries: number
  routes_with_unscoped_writes: number
  routes_without_tenant_context: number
}

export interface TraceResult<E = TraceEntry, S = Record<string, number>> {
  pattern: TracePattern
  total_routes: number
  results: E[]
  summary: S
}

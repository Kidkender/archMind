/**
 * M1 Spike: Span → Graph Node Correlation
 *
 * Goal: prove we can reliably map OTel spans back to IntermediateExecutionGraph nodes.
 * No abstractions. No packages. Just raw mapping logic + a pass/fail rate.
 *
 * Run: node --loader ts-node/esm spike/correlate.ts
 */

import { readFileSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Types (inline — no imports from packages) ───────────────────────────────

interface OtelAttribute {
  key: string
  value: { stringValue?: string; intValue?: number; boolValue?: boolean }
}

interface RawSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtelAttribute[]
  status?: { code: number }
}

interface GraphNode {
  id: string
  type: string
  symbol: string
  file?: string
  args?: string[]
}

interface CorrelationResult {
  spanId: string
  spanName: string
  matched: GraphNode | null
  strategy: string
  confidence: "exact" | "high" | "partial" | "none"
}

// ─── Load OTLP JSON ──────────────────────────────────────────────────────────

function loadOtlpSession(path: string): RawSpan[] {
  const raw = JSON.parse(readFileSync(path, "utf-8"))
  const spans: RawSpan[] = []
  for (const rs of raw.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      spans.push(...(ss.spans ?? []))
    }
  }
  return spans
}

function getAttr(span: RawSpan, key: string): string | undefined {
  return span.attributes.find(a => a.key === key)?.value?.stringValue
}

function durationMs(span: RawSpan): number {
  return (
    (parseInt(span.endTimeUnixNano, 10) - parseInt(span.startTimeUnixNano, 10)) / 1_000_000
  )
}

// ─── Graph nodes (from LARAVEL-AUTH-001 golden trace — hardcoded for spike) ──

const GRAPH_NODES: GraphNode[] = [
  { id: "sanctum",              type: "middleware",      symbol: "auth:sanctum" },
  { id: "resolve_tenant",       type: "middleware",      symbol: "ResolveTenant::handle",         file: "app/Http/Middleware/ResolveTenant.php" },
  { id: "check_permission",     type: "middleware",      symbol: "CheckPermission::handle",        file: "app/Http/Middleware/CheckPermission.php", args: ["task.update"] },
  { id: "task_controller_update", type: "controller",   symbol: "TaskController::update",         file: "app/Modules/Task/Http/Controllers/TaskController.php" },
  { id: "update_task_request",  type: "form_request",   symbol: "UpdateTaskRequest::authorize",   file: "app/Modules/Task/Requests/UpdateTaskRequest.php" },
  { id: "task_policy_update",   type: "policy",         symbol: "TaskPolicy::update",             file: "app/Policies/TaskPolicy.php" },
  { id: "permission_service_1", type: "service_call",   symbol: "PermissionService::hasPermission", file: "app/Modules/Access/Services/PermissionService.php" },
  { id: "permission_service_2", type: "service_call",   symbol: "PermissionService::hasPermission", file: "app/Modules/Access/Services/PermissionService.php" },
]

// ─── Correlation strategies ──────────────────────────────────────────────────

/**
 * Strategy 1 — Exact symbol match.
 * span.name === node.symbol
 */
function tryExactSymbol(span: RawSpan, nodes: GraphNode[]): GraphNode | null {
  return nodes.find(n => n.symbol === span.name) ?? null
}

/**
 * Strategy 2 — code.namespace + code.function → ClassName::method match.
 * Most reliable for instrumented code.
 */
function tryNamespaceFunction(span: RawSpan, nodes: GraphNode[]): GraphNode | null {
  const ns  = getAttr(span, "code.namespace")
  const fn_ = getAttr(span, "code.function")
  if (!ns || !fn_) return null

  // Extract short class name: "App\Http\Middleware\CheckPermission" → "CheckPermission"
  const className = ns.split("\\").at(-1)!
  const symbol = `${className}::${fn_}`

  return nodes.find(n => n.symbol === symbol) ?? null
}

/**
 * Strategy 3 — Middleware name attribute partial match.
 * span attribute "middleware.name" contains a class name fragment.
 */
function tryMiddlewareName(span: RawSpan, nodes: GraphNode[]): GraphNode | null {
  const mwName = getAttr(span, "middleware.name") ?? getAttr(span, "laravel.middleware")
  if (!mwName) return null

  // "auth:sanctum" → exact
  // "CheckPermission" → match symbol containing "CheckPermission"
  return (
    nodes.find(n => n.symbol === mwName) ??
    nodes.find(n => n.type === "middleware" && n.symbol.startsWith(`${mwName}::`)) ??
    null
  )
}

/**
 * Strategy 4 — span.name contains class name in symbol (partial).
 * Last resort.
 */
function tryPartialSymbol(span: RawSpan, nodes: GraphNode[]): GraphNode | null {
  // Skip infra spans
  if (span.name.startsWith("db.") || span.name === "PUT /tasks/{id}") return null

  return (
    nodes.find(n => n.symbol.includes(span.name)) ??
    nodes.find(n => span.name.includes(n.symbol.split("::")[0]!)) ??
    null
  )
}

// ─── Main correlation ────────────────────────────────────────────────────────

function correlateSpan(span: RawSpan, nodes: GraphNode[]): CorrelationResult {
  let matched: GraphNode | null
  let strategy: string
  let confidence: CorrelationResult["confidence"]

  if ((matched = tryExactSymbol(span, nodes))) {
    strategy = "exact_symbol"
    confidence = "exact"
  } else if ((matched = tryNamespaceFunction(span, nodes))) {
    strategy = "namespace_function"
    confidence = "exact"
  } else if ((matched = tryMiddlewareName(span, nodes))) {
    strategy = "middleware_name"
    confidence = "high"
  } else if ((matched = tryPartialSymbol(span, nodes))) {
    strategy = "partial_symbol"
    confidence = "partial"
  } else {
    strategy = "unmatched"
    confidence = "none"
  }

  return { spanId: span.spanId, spanName: span.name, matched, strategy, confidence }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const sessionPath = resolve(__dirname, "sessions/put-tasks-id.json")
const spans = loadOtlpSession(sessionPath)

// Filter root span (the HTTP request itself — not a graph node)
const rootSpan = spans.find(s => !s.parentSpanId || s.parentSpanId === "")
const infraSpans = spans.filter(s => s.name.startsWith("db."))
const candidateSpans = spans.filter(s => s !== rootSpan && !infraSpans.includes(s))

console.log(`\n=== M1 Correlation Spike: PUT /tasks/{id} ===`)
console.log(`Entrypoint from root span: ${getAttr(rootSpan!, "http.route") ?? rootSpan?.name}`)
console.log(`Total spans: ${spans.length}  |  Infra (db.*): ${infraSpans.length}  |  Candidate: ${candidateSpans.length}`)
console.log(`Graph nodes: ${GRAPH_NODES.length}\n`)

const results = candidateSpans.map(s => correlateSpan(s, GRAPH_NODES))

// Print per-span results
for (const r of results) {
  const icon = r.confidence === "none" ? "✗" : r.confidence === "partial" ? "~" : "✓"
  const matched = r.matched ? `${r.matched.id} (${r.matched.symbol})` : "UNMATCHED"
  const dur = durationMs(candidateSpans.find(s => s.spanId === r.spanId)!)
  console.log(`${icon} [${r.strategy.padEnd(20)}] "${r.spanName.padEnd(35)}" → ${matched}  (${dur.toFixed(1)}ms)`)
}

// Infra spans (db queries)
console.log(`\n--- Infra spans (db.query) ---`)
for (const s of infraSpans) {
  const stmt = getAttr(s, "db.statement") ?? "?"
  const dur = durationMs(s)
  console.log(`  db  "${stmt.substring(0, 60)}"  (${dur.toFixed(1)}ms)`)
}

// Summary
const matched = results.filter(r => r.confidence !== "none").length
const exact = results.filter(r => r.confidence === "exact").length
const rate = ((matched / results.length) * 100).toFixed(1)

console.log(`\n=== Results ===`)
console.log(`Matched:  ${matched}/${results.length}  (${rate}%)`)
console.log(`  exact:    ${exact}`)
console.log(`  partial:  ${results.filter(r => r.confidence === "partial").length}`)
console.log(`  none:     ${results.filter(r => r.confidence === "none").length}`)

// Strategy breakdown
const byStrategy = Map.groupBy(results, r => r.strategy)
console.log(`\nStrategies used:`)
for (const [s, rs] of byStrategy) {
  console.log(`  ${s.padEnd(22)} ${rs.length} spans`)
}

// Gate check
const GATE_THRESHOLD = 0.7
if (matched / results.length >= GATE_THRESHOLD) {
  console.log(`\n✅ GATE PASS: correlation rate ${rate}% >= ${GATE_THRESHOLD * 100}% — proceed to M2`)
} else {
  console.log(`\n❌ GATE FAIL: correlation rate ${rate}% < ${GATE_THRESHOLD * 100}% — redesign correlation before M2`)
}

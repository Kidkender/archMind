/**
 * M1 Spike: Span → Graph Node Correlation
 * Plain ESM JS — no build step needed.
 *
 * Run: node spike/correlate.mjs
 */

import { readFileSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Load OTLP JSON ──────────────────────────────────────────────────────────

function loadOtlpSession(path) {
  const raw = JSON.parse(readFileSync(path, "utf-8"))
  const spans = []
  for (const rs of raw.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      spans.push(...(ss.spans ?? []))
    }
  }
  return spans
}

function getAttr(span, key) {
  return span.attributes.find(a => a.key === key)?.value?.stringValue
}

function durationMs(span) {
  return (parseInt(span.endTimeUnixNano) - parseInt(span.startTimeUnixNano)) / 1_000_000
}

// ─── Graph nodes (hardcoded from LARAVEL-AUTH-001 for spike) ─────────────────

const GRAPH_NODES = [
  { id: "sanctum",                type: "middleware",   symbol: "auth:sanctum" },
  { id: "resolve_tenant",         type: "middleware",   symbol: "ResolveTenant::handle" },
  { id: "check_permission",       type: "middleware",   symbol: "CheckPermission::handle",         args: ["task.update"] },
  { id: "task_controller_update", type: "controller",   symbol: "TaskController::update" },
  { id: "update_task_request",    type: "form_request", symbol: "UpdateTaskRequest::authorize" },
  { id: "task_policy_update",     type: "policy",       symbol: "TaskPolicy::update" },
  { id: "permission_service_1",   type: "service_call", symbol: "PermissionService::hasPermission" },
  { id: "permission_service_2",   type: "service_call", symbol: "PermissionService::hasPermission" },
]

// ─── Correlation strategies ──────────────────────────────────────────────────

/** Strategy 1 — span.name === node.symbol */
function tryExactSymbol(span, nodes) {
  return nodes.find(n => n.symbol === span.name) ?? null
}

/** Strategy 2 — code.namespace + code.function → ClassName::method */
function tryNamespaceFunction(span, nodes) {
  const ns  = getAttr(span, "code.namespace")
  const fn_ = getAttr(span, "code.function")
  if (!ns || !fn_) return null
  const className = ns.split("\\").at(-1)
  const symbol = `${className}::${fn_}`
  return nodes.find(n => n.symbol === symbol) ?? null
}

/** Strategy 3 — middleware.name attribute match */
function tryMiddlewareName(span, nodes) {
  const mwName = getAttr(span, "middleware.name") ?? getAttr(span, "laravel.middleware")
  if (!mwName) return null
  return (
    nodes.find(n => n.symbol === mwName) ??
    nodes.find(n => n.type === "middleware" && n.symbol.startsWith(`${mwName}::`)) ??
    null
  )
}

/** Strategy 4 — partial symbol match (last resort) */
function tryPartialSymbol(span, nodes) {
  if (span.name.startsWith("db.") || span.name.startsWith("PUT ")) return null
  return (
    nodes.find(n => n.symbol.includes(span.name)) ??
    nodes.find(n => span.name.includes(n.symbol.split("::")[0])) ??
    null
  )
}

function correlateSpan(span, nodes) {
  let matched, strategy, confidence

  if ((matched = tryExactSymbol(span, nodes))) {
    strategy = "exact_symbol"; confidence = "exact"
  } else if ((matched = tryNamespaceFunction(span, nodes))) {
    strategy = "namespace_function"; confidence = "exact"
  } else if ((matched = tryMiddlewareName(span, nodes))) {
    strategy = "middleware_name"; confidence = "high"
  } else if ((matched = tryPartialSymbol(span, nodes))) {
    strategy = "partial_symbol"; confidence = "partial"
  } else {
    matched = null; strategy = "unmatched"; confidence = "none"
  }

  return { spanId: span.spanId, spanName: span.name, matched, strategy, confidence }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const sessionPath = resolve(__dirname, "sessions/put-tasks-id.json")
const spans = loadOtlpSession(sessionPath)

const rootSpan      = spans.find(s => !s.parentSpanId || s.parentSpanId === "")
const infraSpans    = spans.filter(s => s.name.startsWith("db."))
const candidateSpans = spans.filter(s => s !== rootSpan && !infraSpans.includes(s))

console.log(`\n=== M1 Correlation Spike: PUT /tasks/{id} ===`)
console.log(`Entrypoint: ${getAttr(rootSpan, "http.route") ?? rootSpan?.name}`)
console.log(`Spans: total=${spans.length}  infra=${infraSpans.length}  candidate=${candidateSpans.length}`)
console.log(`Graph nodes: ${GRAPH_NODES.length}\n`)

const results = candidateSpans.map(s => correlateSpan(s, GRAPH_NODES))

// Per-span output
for (const r of results) {
  const icon = r.confidence === "none" ? "✗" : r.confidence === "partial" ? "~" : "✓"
  const target = r.matched ? `${r.matched.id} (${r.matched.symbol})` : "UNMATCHED"
  const dur = durationMs(candidateSpans.find(s => s.spanId === r.spanId))
  console.log(
    `${icon} [${r.strategy.padEnd(20)}]  "${r.spanName.padEnd(35)}"  →  ${target}  (${dur.toFixed(1)}ms)`
  )
}

// Infra spans
console.log(`\n--- Infra spans (db.query) ---`)
for (const s of infraSpans) {
  const stmt = (getAttr(s, "db.statement") ?? "?").substring(0, 70)
  console.log(`  ${durationMs(s).toFixed(1).padStart(5)}ms  "${stmt}"`)
}

// Summary
const matchedCount = results.filter(r => r.confidence !== "none").length
const exactCount   = results.filter(r => r.confidence === "exact").length
const partialCount = results.filter(r => r.confidence === "partial").length
const noneCount    = results.filter(r => r.confidence === "none").length
const rate = (matchedCount / results.length * 100).toFixed(1)

console.log(`\n=== Summary ===`)
console.log(`Matched: ${matchedCount}/${results.length}  (${rate}%)`)
console.log(`  exact:   ${exactCount}`)
console.log(`  partial: ${partialCount}`)
console.log(`  none:    ${noneCount}`)

// Strategy breakdown
const stratCounts = {}
for (const r of results) {
  stratCounts[r.strategy] = (stratCounts[r.strategy] ?? 0) + 1
}
console.log(`\nStrategies used:`)
for (const [s, count] of Object.entries(stratCounts)) {
  console.log(`  ${s.padEnd(22)}  ${count}x`)
}

// Gate check
const GATE = 0.7
const pass = matchedCount / results.length >= GATE
console.log(`\n${pass ? "✅ GATE PASS" : "❌ GATE FAIL"}: ${rate}% ${pass ? ">=" : "<"} ${GATE * 100}% threshold`)
if (pass) {
  console.log(`   → Proceed to M2: protocol types + runtime-ingest package`)
} else {
  console.log(`   → Redesign correlation strategy before M2`)
}
console.log()

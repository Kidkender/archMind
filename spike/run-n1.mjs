/**
 * End-to-end M3 verification: ingest → correlate → detect N+1
 * Run: node spike/run-n1.mjs
 */

import { readFileSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Inline ingest (no package imports — spike only) ─────────────────────────

function loadOtlp(path) {
  const raw = JSON.parse(readFileSync(path, "utf-8"))
  const spans = []
  for (const rs of raw.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      spans.push(...(ss.spans ?? []))
    }
  }
  return spans
}

function flatAttrs(attrs = []) {
  const r = {}
  for (const a of attrs) {
    const v = a.value
    if (v.stringValue !== undefined) r[a.key] = v.stringValue
    else if (v.intValue !== undefined) r[a.key] = v.intValue
    else if (v.boolValue !== undefined) r[a.key] = v.boolValue
  }
  return r
}

function buildSession(rawSpans) {
  const spans = rawSpans.map(s => ({
    ...s,
    parentSpanId: s.parentSpanId || undefined,
    attributes:   flatAttrs(s.attributes),
  }))
  const root = spans.find(s => !s.parentSpanId)
  return {
    sessionId:  spans[0]?.traceId ?? "?",
    entrypoint: root?.attributes["http.route"] ?? root?.name ?? "?",
    durationMs: root ? (parseInt(root.endTimeUnixNano) - parseInt(root.startTimeUnixNano)) / 1e6 : 0,
    spans,
    recordedAt: new Date().toISOString(),
  }
}

// ─── Inline correlate ─────────────────────────────────────────────────────────

const GRAPH_NODES = [
  { id: "ctrl",  type: "controller",   symbol: "TaskController::index" },
  { id: "svc",   type: "service_call", symbol: "TaskService::getAssignee" },
]

function correlate(session) {
  const root       = session.spans.find(s => !s.parentSpanId)
  const infra      = session.spans.filter(s => s !== root && /^db\./.test(s.name))
  const candidates = session.spans.filter(s => s !== root && !/^db\./.test(s.name))

  const correlations = candidates.map(span => {
    // try exact
    let node = GRAPH_NODES.find(n => n.symbol === span.name)
    let strategy = "exact_symbol"
    if (!node) {
      const ns = span.attributes["code.namespace"]
      const fn = span.attributes["code.function"]
      if (ns && fn) {
        const cls = ns.split("\\").at(-1)
        node = GRAPH_NODES.find(n => n.symbol === `${cls}::${fn}`)
        strategy = "namespace_function"
      }
    }
    return { span, nodeId: node?.id ?? null, strategy, confidence: node ? "exact" : "none" }
  })

  const matched = correlations.filter(c => c.confidence !== "none").length
  return {
    session,
    correlations,
    correlationRate: candidates.length > 0 ? matched / candidates.length : 0,
    infraSpans: infra,
  }
}

// ─── Inline N+1 detect ───────────────────────────────────────────────────────

function extractTable(stmt) {
  const m = stmt.match(/\bFROM\s+[`"]?(\w+)[`"]?/i) ?? stmt.match(/\bUPDATE\s+[`"]?(\w+)[`"]?/i)
  return m?.[1]?.toLowerCase() ?? null
}

function detectN1(correlated, threshold = 5) {
  const findings = []
  const dbSpans = correlated.infraSpans.filter(s => s.attributes["db.statement"])
  if (dbSpans.length < threshold) return findings

  // group by parent
  const byParent = new Map()
  for (const s of dbSpans) {
    const key = s.parentSpanId ?? "__root__"
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key).push(s)
  }

  for (const [parentId, spans] of byParent) {
    const byTable = new Map()
    for (const s of spans) {
      const table = extractTable(String(s.attributes["db.statement"]))
      if (!table) continue
      if (!byTable.has(table)) byTable.set(table, { table, spanIds: [], stmt: s.attributes["db.statement"] })
      byTable.get(table).spanIds.push(s.spanId)
    }
    for (const group of byTable.values()) {
      if (group.spanIds.length < threshold) continue
      const parentCorr = correlated.correlations.find(c => c.span.spanId === parentId)
      findings.push({
        type:     "n_plus_one",
        severity: group.spanIds.length >= 10 ? "high" : "medium",
        count:    group.spanIds.length,
        table:    group.table,
        nodeId:   parentCorr?.nodeId ?? null,
        evidence: `${group.spanIds.length}× SELECT from \`${group.table}\` under parent "${parentId}"`,
      })
    }
  }
  return findings
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const rawSpans  = loadOtlp(resolve(__dirname, "sessions/get-tasks-n1.json"))
const session   = buildSession(rawSpans)
const correlated = correlate(session)
const findings  = detectN1(correlated)

console.log(`\n=== M3 End-to-End: N+1 Detection ===`)
console.log(`Entrypoint:       ${session.entrypoint}`)
console.log(`Total spans:      ${session.spans.length}`)
console.log(`Infra spans:      ${correlated.infraSpans.length}`)
console.log(`Candidates:       ${correlated.correlations.length}`)
console.log(`Correlation rate: ${(correlated.correlationRate * 100).toFixed(0)}%`)

console.log(`\nCorrelations:`)
for (const c of correlated.correlations) {
  const icon = c.confidence === "none" ? "✗" : "✓"
  console.log(`  ${icon} "${c.span.name}" → ${c.nodeId ?? "UNMATCHED"} [${c.strategy}]`)
}

console.log(`\nFindings:`)
if (findings.length === 0) {
  console.log("  (none)")
} else {
  for (const f of findings) {
    console.log(`  [${f.severity.toUpperCase()}] ${f.type}: ${f.evidence}`)
    console.log(`         correlated node: ${f.nodeId ?? "(unmatched)"}`)
  }
}

const pass = findings.length > 0 && findings[0].count >= 10 && findings[0].table === "users"
console.log(`\n${pass ? "✅ M3 PASS" : "❌ M3 FAIL"}: N+1 detected on 'users' table with count=${findings[0]?.count ?? 0}`)

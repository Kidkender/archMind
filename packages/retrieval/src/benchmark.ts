import { join } from "path"
import { readdirSync } from "fs"
import { loadGoldenTrace, scoreRetrieval } from "@archmind/scorer"
import type { GoldenTrace } from "@archmind/scorer"
import type { IntermediateExecutionGraph } from "@archmind/protocol"
import { retrieve, prune } from "./retrieval-engine.js"
import { naiveRag, compare } from "./naive-rag.js"

// ---- Public API -------------------------------------------------------

export interface TraceSnapshot {
  entrypoint:        string
  naive_rag_tokens:  number
  naive_rag_files:   number
  r0_tokens:         number
  r0_recall:         number
  r1_tokens:         number
  r1_recall:         number
  compression_r0:    number
  compression_r1:    number
  token_savings_r0:  number   // percent
  token_savings_r1:  number   // percent
  recall_gap:        number   // 1.0 - r0_recall
  recall_gap_reason: "extraction_ceiling" | "retrieval_failure" | "cross_cutting" | "ok"
  missing_high_nodes: string[]
}

export interface BenchmarkSnapshot {
  timestamp:  string
  label:      string
  traces:     Record<string, TraceSnapshot>
  summary: {
    avg_r0_recall:       number
    avg_compression_r0:  number
    avg_token_savings_r0: number
    total_traces:        number
  }
}

export function runBenchmark(opts: {
  goldenDir:   string
  fixtureDir:  string
  graphs:      Record<string, IntermediateExecutionGraph[]>  // golden_id → extracted graphs
  label?:      string
}): BenchmarkSnapshot {
  const { goldenDir, fixtureDir, graphs, label = "snapshot" } = opts

  const traceFiles = readdirSync(goldenDir).filter((f) => f.endsWith(".yaml"))
  const traces: Record<string, TraceSnapshot> = {}

  for (const file of traceFiles) {
    const golden = loadGoldenTrace(join(goldenDir, file))
    const id     = golden.id
    const gs     = graphs[id] ?? []

    // Naive RAG
    const naive = naiveRag(golden, fixtureDir)

    // ArchMind R0
    const r0 = retrieve({ entrypoint: golden.entrypoint }, gs)
    if (!r0) {
      // Cross-cutting or missing entrypoint — skip detailed metrics
      traces[id] = buildSkipSnapshot(golden, naive)
      continue
    }

    // ArchMind R1 (auth focus)
    const r1 = prune(r0, "HIGH")

    const r0Score = scoreRetrieval(golden, r0)
    const r1Score = scoreRetrieval(golden, r1)
    const r0Cmp   = compare(naive, r0.token_estimate, r0Score.combined_recall)
    const r1Cmp   = compare(naive, r1.token_estimate, r1Score.combined_recall)

    const missingHigh = golden.nodes
      .filter((n) => n.retrieval?.relevance === "HIGH")
      .filter((n) => !r0.nodes.some((e) => {
        const es = e.symbol.toLowerCase()
        const gs = n.symbol.toLowerCase()
        return es === gs || es.includes(gs) || gs.includes(es)
      }))
      .map((n) => n.id)

    const recallGapReason = classifyRecallGap(r0Score.combined_recall, missingHigh, golden)

    traces[id] = {
      entrypoint:        golden.entrypoint,
      naive_rag_tokens:  naive.token_estimate,
      naive_rag_files:   naive.files.length,
      r0_tokens:         r0.token_estimate,
      r0_recall:         r0Score.combined_recall,
      r1_tokens:         r1.token_estimate,
      r1_recall:         r1Score.combined_recall,
      compression_r0:    parseFloat(r0Cmp.compression_ratio.toFixed(2)),
      compression_r1:    parseFloat(r1Cmp.compression_ratio.toFixed(2)),
      token_savings_r0:  parseFloat(r0Cmp.token_savings_pct.toFixed(1)),
      token_savings_r1:  parseFloat(r1Cmp.token_savings_pct.toFixed(1)),
      recall_gap:        parseFloat((1 - r0Score.combined_recall).toFixed(2)),
      recall_gap_reason: recallGapReason,
      missing_high_nodes: missingHigh,
    }
  }

  const scored = Object.values(traces).filter((t) => t.recall_gap_reason !== "cross_cutting")
  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0

  return {
    timestamp: new Date().toISOString(),
    label,
    traces,
    summary: {
      avg_r0_recall:        parseFloat(avg(scored.map((t) => t.r0_recall)).toFixed(2)),
      avg_compression_r0:   parseFloat(avg(scored.map((t) => t.compression_r0)).toFixed(2)),
      avg_token_savings_r0: parseFloat(avg(scored.map((t) => t.token_savings_r0)).toFixed(1)),
      total_traces:         Object.keys(traces).length,
    },
  }
}

// ---- Helpers ----------------------------------------------------------

function classifyRecallGap(
  recall: number,
  missingHighNodes: string[],
  golden: GoldenTrace
): TraceSnapshot["recall_gap_reason"] {
  if (golden.entrypoint.includes("*") || golden.entrypoint.startsWith("ANY")) {
    return "cross_cutting"
  }
  if (recall >= 0.99) return "ok"
  // If missing nodes are all service_call / deeper types that aren't yet extracted
  const allMissingAreDeeper = missingHighNodes.every((id) => {
    const node = golden.nodes.find((n) => n.id === id)
    return node?.type === "service_call" || node?.type === "permission" || node?.type === "runtime_injection"
  })
  return allMissingAreDeeper ? "extraction_ceiling" : "retrieval_failure"
}

function buildSkipSnapshot(golden: GoldenTrace, naive: ReturnType<typeof naiveRag>): TraceSnapshot {
  return {
    entrypoint:         golden.entrypoint,
    naive_rag_tokens:   naive.token_estimate,
    naive_rag_files:    naive.files.length,
    r0_tokens:          0,
    r0_recall:          0,
    r1_tokens:          0,
    r1_recall:          0,
    compression_r0:     0,
    compression_r1:     0,
    token_savings_r0:   0,
    token_savings_r1:   0,
    recall_gap:         1,
    recall_gap_reason:  "cross_cutting",
    missing_high_nodes: [],
  }
}

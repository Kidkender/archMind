import type { IntermediateExecutionGraph } from "@archmind/protocol"
import { explain } from "@archmind/explainer"
import { retrieve } from "@archmind/retrieval"
import { classifyQuery } from "@archmind/explainer"
import { buildPrompt } from "@archmind/prompt-builder"
import { validateLLMResponse } from "@archmind/llm-client"
import type { LLMClient, LLMResponse } from "@archmind/llm-client"
import type { OrchestratorOptions, QueryResult } from "./types.js"

const FOCUS_MAP: Record<string, "auth" | "validation" | "runtime" | "transaction" | "isolation" | "all"> = {
  auth: "auth",
  validation: "validation",
  runtime: "runtime",
  transaction: "transaction",
  isolation: "isolation",
  all: "all",
}

export class Orchestrator {
  private readonly graphs: IntermediateExecutionGraph[]
  private readonly llmClient: LLMClient

  constructor(opts: OrchestratorOptions) {
    this.graphs = opts.graphs
    this.llmClient = opts.llmClient
  }

  async query(entrypoint: string, userQuery: string): Promise<QueryResult> {
    const graph = this.graphs.find((g) => g.entrypoint === entrypoint)
    if (!graph) throw new Error(`No graph found for entrypoint: ${entrypoint}`)

    const queryCtx = classifyQuery(userQuery)
    const focus = FOCUS_MAP[queryCtx.focus] ?? "all"

    const retrieved = retrieve({ entrypoint, focus }, this.graphs)
    const retrievedGraph: IntermediateExecutionGraph = retrieved
      ? { ...graph, nodes: retrieved.nodes, edges: retrieved.edges }
      : graph

    const findings = explain(graph, userQuery || undefined)

    const prompt = buildPrompt({ query: userQuery, graph: retrievedGraph, findings })

    let response: LLMResponse
    let explanation_failed = false

    try {
      const callResult = await this.llmClient.call(prompt)
      const validation = validateLLMResponse(callResult.response)
      if (validation.valid) {
        response = callResult.response
      } else {
        const retry = await this.llmClient.call(prompt)
        const retryValidation = validateLLMResponse(retry.response)
        if (retryValidation.valid) {
          response = retry.response
        } else {
          explanation_failed = true
          response = this.fallbackResponse(findings)
        }
      }
    } catch {
      explanation_failed = true
      response = this.fallbackResponse(findings)
    }

    return {
      query: userQuery,
      entrypoint,
      response,
      explanation_failed,
      findings_count: findings.length,
      token_estimate: retrieved?.token_estimate ?? estimateTokens(graph),
    }
  }

  private fallbackResponse(findings: ReturnType<typeof explain>): LLMResponse {
    const top = findings[0]
    return {
      finding_type: top?.type ?? "unknown",
      severity: (top?.severity === "INFO" ? "LOW" : top?.severity) ?? "LOW",
      confidence: top?.confidence ?? "LOW",
      explanation: top?.summary ?? "No explanation available.",
      key_nodes: top?.provenance.supporting_nodes ?? [],
      recommendations: top?.recommendations ?? [],
      uncertainty: "Explanation generation failed — showing raw detector output.",
    }
  }
}

function estimateTokens(graph: IntermediateExecutionGraph): number {
  return graph.nodes.length * 20 + graph.edges.length * 10
}

import type { IntermediateExecutionGraph } from "@archmind/protocol"
import type { LLMResponse, LLMClient } from "@archmind/llm-client"

export interface OrchestratorOptions {
  graphs: IntermediateExecutionGraph[]
  llmClient: LLMClient
}

export interface QueryResult {
  query: string
  entrypoint: string
  response: LLMResponse
  explanation_failed: boolean
  findings_count: number
  token_estimate: number
}

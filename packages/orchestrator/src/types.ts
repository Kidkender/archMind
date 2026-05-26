import type { IntermediateExecutionGraph } from "@archmind/protocol"
import type { LLMResponse, LLMClient } from "@archmind/llm-client"
import type { ConversationContext } from "@archmind/protocol"

export type { ConversationTurn, ConversationContext, QueryMode } from "@archmind/protocol"
export { MAX_CONVERSATION_TURNS } from "@archmind/protocol"

export interface OrchestratorOptions {
  graphs: IntermediateExecutionGraph[]
  llmClient: LLMClient
  projectRoot?: string
}

export interface QueryResult {
  query: string
  entrypoint: string
  response: LLMResponse
  explanation_failed: boolean
  findings_count: number
  token_estimate: number
  conversation: ConversationContext
}

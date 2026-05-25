export type QueryMode = "review" | "teach" | "debug"

export interface ConversationTurn {
  query: string
  response: {
    finding_type: string
    severity: string
    explanation: string
    recommendations: string[]
    uncertainty?: string | null
  }
}

export interface ConversationContext {
  entrypoint: string
  turns: ConversationTurn[]
}

export const MAX_CONVERSATION_TURNS = 5

export type QueryMode = "review" | "teach" | "debug"

export interface ConversationTurnResponse {
  finding_type:    string
  severity:        string
  explanation:     string
  recommendations: string[]
  uncertainty?:    string | null
}

export interface ConversationTurn {
  query:    string
  response: ConversationTurnResponse
}

export interface ConversationContext {
  entrypoint: string
  turns:      ConversationTurn[]
}

export const MAX_CONVERSATION_TURNS = 5

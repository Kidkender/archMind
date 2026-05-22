export interface AuthorizationCheckFact {
  kind: "authorization_check"
  nodeId: string
  symbol: string
  permission: string | null   // raw permission string from args/mechanism
  ability: string | null      // normalized: "task.update" | "TASK_UPDATE" → "update"
  layer: "middleware" | "policy" | "service" | "constant" | "unknown"
  mechanism: string | null
  confidence: "HIGH" | "MEDIUM" | "LOW"
}

export interface ValidationGateFact {
  kind: "validation_gate"
  nodeId: string
  symbol: string
  validatesInput: boolean
  delegatesAuthorization: boolean
  layer: "form_request" | "controller" | "unknown"
  confidence: "HIGH" | "MEDIUM" | "LOW"
}

export interface RuntimeInjectionFact {
  kind: "runtime_injection"
  nodeId: string
  symbol: string
  injectedValue: string
  sideEffect: string
  confidence: "HIGH" | "MEDIUM" | "LOW"
}

export type SemanticFact =
  | AuthorizationCheckFact
  | ValidationGateFact
  | RuntimeInjectionFact

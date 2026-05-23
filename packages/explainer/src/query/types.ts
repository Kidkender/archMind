export type QueryFocus = "auth" | "validation" | "runtime" | "transaction" | "isolation" | "all"

export interface QueryContext {
  raw: string
  focus: QueryFocus
}

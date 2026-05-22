export type QueryFocus = "auth" | "validation" | "runtime" | "all"

export interface QueryContext {
  raw: string
  focus: QueryFocus
}

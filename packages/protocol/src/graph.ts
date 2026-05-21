// Core graph types — structural definitions only.
// Node/edge `type` and `relation` are string, not enum: ontology is being discovered.

export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN"

export type EdgeTraceability = "static" | "semantic" | "runtime" | "probabilistic"

export interface ExecutionNode {
  id:        string
  type:      string    // free-form: "middleware", "controller", "policy", etc.
  symbol:    string    // e.g. "ResolveTenant::handle", "auth:sanctum"
  file?:     string    // relative path from project root
  args?:     string[]  // e.g. ["task.update"] for CheckPermission
  role?:     string    // semantic hint: "auth_layer_1", "tenant_resolver", etc.
}

export interface ExecutionEdge {
  from:          string
  to:            string
  relation:      string           // free-form: "next_middleware", "policy_check", etc.
  traceability:  EdgeTraceability
  mechanism?:    string           // e.g. "$this->authorize('update', $task)"
  side_effect?:  string           // e.g. "injects app('tenant')"
}

export interface GraphAnnotation {
  type:        string
  nodes?:      string[]
  description: string
  severity?:   "critical" | "high" | "medium" | "low" | "info"
  fix?:        string
  confidence?: Confidence
  evidence?:   string[]
}

export interface IntermediateExecutionGraph {
  entrypoint:   string            // e.g. "PUT /tasks/{id}"
  method:       string            // "GET" | "POST" | "PUT" | "DELETE" | "PATCH"
  path:         string            // e.g. "/tasks/{id}"
  nodes:        ExecutionNode[]
  edges:        ExecutionEdge[]
  annotations:  GraphAnnotation[]
}

import { readFileSync } from "fs"
import yaml from "js-yaml"

export type RetrievalRelevance = "HIGH" | "MEDIUM" | "LOW"

export interface NodeRetrieval {
  relevance:          RetrievalRelevance
  compressible:       boolean
  compressed_summary?: string
}

export interface TraceRetrieval {
  query: string
}

export interface GoldenNode {
  id:        string
  type:      string
  symbol:    string
  file?:     string
  args?:     string[]
  called_by?: string
  retrieval?: NodeRetrieval
}

export interface GoldenEdge {
  from:        string
  to:          string
  relation:    string
  side_effect?: string
  via?:        string
}

export interface GoldenAnnotation {
  type:        string
  nodes?:      string[]
  description: string
}

export interface ExpectedFinding {
  type:           string
  required_nodes: string[]
}

export interface GoldenTrace {
  id:                string
  entrypoint:        string
  framework:         string
  source_project?:   string
  retrieval?:        TraceRetrieval
  nodes:             GoldenNode[]
  edges:             GoldenEdge[]
  annotations?:      GoldenAnnotation[]
  expected_findings?:    ExpectedFinding[]
  expected_top_finding?: string
}

export function loadGoldenTrace(filePath: string): GoldenTrace {
  const raw = readFileSync(filePath, "utf-8")
  return yaml.load(raw) as GoldenTrace
}

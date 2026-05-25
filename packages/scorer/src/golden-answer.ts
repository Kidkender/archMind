import { readFileSync } from "fs"
import yaml from "js-yaml"

export interface GoldenAnswerExpected {
  finding_type: string
  severity: string
  key_nodes: string[]
  explanation_must_contain: string[]
  // Each element is an OR-group: at least one phrase in the group must appear.
  recommendations_must_contain: string[][]
}

export interface GoldenAnswer {
  id: string
  golden_trace_id: string
  entrypoint: string
  query: string
  expected_response: GoldenAnswerExpected
}

export function loadGoldenAnswer(filePath: string): GoldenAnswer {
  const raw = readFileSync(filePath, "utf-8")
  return yaml.load(raw) as GoldenAnswer
}

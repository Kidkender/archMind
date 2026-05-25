import { readFileSync } from "fs"
import yaml from "js-yaml"

export interface GoldenConvTurnExpected {
  finding_type?: string
  severity?: string
  explanation_must_contain?: string[]
  recommendations_must_contain?: string[][]
}

export interface GoldenConvTurn {
  query: string
  expected: GoldenConvTurnExpected
}

export interface GoldenConversation {
  id: string
  entrypoint: string
  description?: string
  turns: GoldenConvTurn[]
}

export function loadGoldenConversation(filePath: string): GoldenConversation {
  const raw = readFileSync(filePath, "utf-8")
  return yaml.load(raw) as GoldenConversation
}

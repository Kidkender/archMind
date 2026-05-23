import type { IntermediateExecutionGraph } from "@archmind/protocol"
import type { Finding } from "@archmind/explainer"
import { serializeExecutionPath } from "./serialize-graph.js"
import { serializeFindings } from "./serialize-findings.js"

export interface PromptInput {
  query: string
  graph: IntermediateExecutionGraph
  findings: Finding[]
}

export interface BuiltPrompt {
  system: string
  user: string
  output_instructions: string
}

const SYSTEM = `You are a semantic code reasoning engine. You explain execution flow and \
security findings based ONLY on the structured context provided below. \
Do NOT infer relationships not explicitly listed. Do NOT reference source \
code not shown. If uncertain, say so.`

const OUTPUT_INSTRUCTIONS = `Respond with a JSON object matching this schema exactly:

{
  "finding_type": "<primary finding type>",
  "severity": "<CRITICAL | HIGH | MEDIUM | LOW>",
  "confidence": "<HIGH | MEDIUM | LOW>",
  "explanation": "<markdown string — 2-4 paragraphs, developer-audience>",
  "key_nodes": ["<symbol>", ...],
  "recommendations": ["<actionable fix>", ...],
  "uncertainty": "<null or one sentence if uncertain>"
}

Rules for explanation:
- Write for a senior developer reading a PR review
- First paragraph: what the finding is and where it occurs
- Second paragraph: why it matters
- Third paragraph (optional): when it is acceptable
- Do NOT reference implementation details not in the provided nodes/edges`

function serializeUncertainty(findings: Finding[]): string {
  const reasons = findings.flatMap((f) => f.uncertainty ?? [])
  if (reasons.length === 0) return ""
  const lines = reasons.map((u) => `- ${u.description}`)
  return `Uncertainty notes:\n${lines.join("\n")}`
}

export function buildPrompt(input: PromptInput): BuiltPrompt {
  const { query, graph, findings } = input

  const executionSection = serializeExecutionPath(graph)
  const findingsSection = serializeFindings(findings)
  const uncertaintySection = serializeUncertainty(findings)

  const userParts: string[] = [
    `User question:\n"${query}"`,
    executionSection,
  ]
  if (findingsSection) userParts.push(findingsSection)
  if (uncertaintySection) userParts.push(uncertaintySection)

  return {
    system: SYSTEM,
    user: userParts.join("\n\n"),
    output_instructions: OUTPUT_INSTRUCTIONS,
  }
}

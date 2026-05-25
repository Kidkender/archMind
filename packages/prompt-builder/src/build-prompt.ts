import type { IntermediateExecutionGraph, ConversationTurn, QueryMode } from "@archmind/protocol"
import type { Finding } from "@archmind/explainer"
import { serializeExecutionPath } from "./serialize-graph.js"
import { serializeFindings } from "./serialize-findings.js"
import { detectContradictions, serializeContradictions } from "./detect-contradictions.js"

export interface PromptInput {
  query: string
  graph: IntermediateExecutionGraph
  findings: Finding[]
  history?: ConversationTurn[]
  mode?: QueryMode
}

export interface BuiltPrompt {
  system: string
  user: string
  output_instructions: string
}

const SYSTEM_BY_MODE: Record<QueryMode, string> = {
  review:
    `You are a semantic code reasoning engine. You explain execution flow and \
security findings based ONLY on the structured context provided below. \
Do NOT infer relationships not explicitly listed. Do NOT reference source \
code not shown. If uncertain, say so.`,

  teach:
    `You are a patient senior engineer explaining a codebase to a junior developer. \
Use the structured context provided — do NOT invent details. \
Explain concepts step by step with analogies where helpful. \
Assume the reader is unfamiliar with the execution path but understands basic PHP/web concepts.`,

  debug:
    `You are a terse debugging assistant. Focus on root cause only. \
Use the structured context provided — do NOT invent details. \
Skip policy background and "why it matters" prose. \
Answer the question directly: what is broken, where, and the minimal fix.`,
}

const OUTPUT_INSTRUCTIONS_BY_MODE: Record<QueryMode, string> = {
  review: `Respond with a JSON object matching this schema exactly:

{
  "finding_type": "<must be the type string of one of the findings listed above, e.g. DUPLICATE_AUTHORIZATION>",
  "severity": "<CRITICAL | HIGH | MEDIUM | LOW>",
  "confidence": "<HIGH | MEDIUM | LOW>",
  "explanation": "<markdown string — 2-4 paragraphs, developer-audience>",
  "key_nodes": ["<symbol>", ...],
  "recommendations": ["<actionable fix>", ...],
  "uncertainty": "<null or one sentence if uncertain>"
}

Rules:
- "finding_type" MUST be exactly one of the types listed in the Semantic findings section above. Do not invent new finding types.
- "key_nodes" must be symbols taken from the Execution path section.
- Write explanation for a senior developer reading a PR review.
- First paragraph: what the finding is and where it occurs.
- Second paragraph: why it matters.
- Third paragraph (optional): when it is acceptable.
- Do NOT reference implementation details not in the provided nodes/edges.`,

  teach: `Respond with a JSON object matching this schema exactly:

{
  "finding_type": "<must be the type string of one of the findings listed above>",
  "severity": "<CRITICAL | HIGH | MEDIUM | LOW>",
  "confidence": "<HIGH | MEDIUM | LOW>",
  "explanation": "<markdown string — 3-5 paragraphs, teaching style with step-by-step breakdown>",
  "key_nodes": ["<symbol>", ...],
  "recommendations": ["<actionable fix with brief why>", ...],
  "uncertainty": "<null or one sentence if uncertain>"
}

Rules:
- "finding_type" MUST be exactly one of the types listed in the Semantic findings section above.
- "key_nodes" must be symbols taken from the Execution path section.
- Write for a junior developer — explain what each node does before explaining the problem.
- Use numbered steps or analogies to clarify execution order.
- Do NOT reference implementation details not in the provided nodes/edges.`,

  debug: `Respond with a JSON object matching this schema exactly:

{
  "finding_type": "<must be the type string of one of the findings listed above>",
  "severity": "<CRITICAL | HIGH | MEDIUM | LOW>",
  "confidence": "<HIGH | MEDIUM | LOW>",
  "explanation": "<markdown string — 1-2 paragraphs max, direct and terse>",
  "key_nodes": ["<symbol>", ...],
  "recommendations": ["<minimal fix — one line each>", ...],
  "uncertainty": "<null or one sentence if uncertain>"
}

Rules:
- "finding_type" MUST be exactly one of the types listed in the Semantic findings section above.
- "key_nodes" must be symbols taken from the Execution path section.
- Be terse: state the root cause, name the node, state the fix. Nothing more.
- Do NOT reference implementation details not in the provided nodes/edges.`,
}

function serializeConversationHistory(history: ConversationTurn[]): string {
  if (history.length === 0) return ""
  const lines: string[] = ["Prior conversation turns:"]
  for (const [i, turn] of history.entries()) {
    lines.push(`\n[Turn ${i + 1}]`)
    lines.push(`Q: ${turn.query}`)
    lines.push(`Finding: ${turn.response.finding_type} (${turn.response.severity})`)
    lines.push(`A: ${turn.response.explanation.slice(0, 400)}${turn.response.explanation.length > 400 ? "…" : ""}`)
  }
  return lines.join("\n")
}

function serializeUncertainty(findings: Finding[]): string {
  const reasons = findings.flatMap((f) => f.uncertainty ?? [])
  if (reasons.length === 0) return ""
  const lines = reasons.map((u) => `- ${u.description}`)
  return `Uncertainty notes:\n${lines.join("\n")}`
}

export function buildPrompt(input: PromptInput): BuiltPrompt {
  const { query, graph, findings, history, mode = "review" } = input

  const executionSection = serializeExecutionPath(graph)
  const findingsSection = serializeFindings(findings)
  const uncertaintySection = serializeUncertainty(findings)
  const historySection = history && history.length > 0 ? serializeConversationHistory(history) : ""
  const contradictionSection = serializeContradictions(detectContradictions(findings))

  const userParts: string[] = [
    `User question:\n"${query}"`,
    executionSection,
  ]
  if (historySection) userParts.push(historySection)
  if (findingsSection) userParts.push(findingsSection)
  if (contradictionSection) userParts.push(contradictionSection)
  if (uncertaintySection) userParts.push(uncertaintySection)

  return {
    system: SYSTEM_BY_MODE[mode],
    user: userParts.join("\n\n"),
    output_instructions: OUTPUT_INSTRUCTIONS_BY_MODE[mode],
  }
}

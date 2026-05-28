import type { RetrievalResult, ExecutionNode } from "@archmind/protocol"

// ---- Public API -------------------------------------------------------

export function serialize(result: RetrievalResult): string {
  const lines: string[] = []

  lines.push(`Execution flow for ${result.entrypoint}:`)
  if (result.pruned) lines.push("(pruned to relevant nodes only)")
  lines.push("")

  const sections = groupBySemantic(result.nodes)

  for (const [heading, nodes] of sections) {
    if (nodes.length === 0) continue
    lines.push(`[${heading}]`)
    for (const node of nodes) {
      lines.push(formatNode(node))
    }
    lines.push("")
  }

  // Append execution characteristics summary when nodes were deduplicated
  const summary = buildExecutionSummary(result.nodes)
  if (summary) {
    lines.push(summary)
    lines.push("")
  }

  // Append notable edges (non-next_middleware)
  const notable = result.edges.filter((e) => e.relation !== "next_middleware")
  if (notable.length > 0) {
    lines.push("[CONNECTIONS]")
    for (const e of notable) {
      const via = e.mechanism ? ` via ${e.mechanism}` : ""
      lines.push(`  ${e.from} → ${e.to} (${e.relation}${via})`)
    }
    lines.push("")
  }

  lines.push(`~${result.token_estimate} tokens`)

  return lines.join("\n").trimEnd()
}

// ---- Grouping ---------------------------------------------------------

type SectionName =
  | "MIDDLEWARE CHAIN"
  | "HANDLER"
  | "VALIDATION"
  | "AUTHORIZATION"
  | "RUNTIME"
  | "OTHER"

const NODE_SECTION: Record<string, SectionName> = {
  middleware: "MIDDLEWARE CHAIN",
  authentication_gate: "MIDDLEWARE CHAIN",
  authorization_check: "MIDDLEWARE CHAIN",
  rate_limiter: "MIDDLEWARE CHAIN",
  controller: "HANDLER",
  controller_action: "HANDLER",
  form_request: "VALIDATION",
  policy: "AUTHORIZATION",
  permission: "AUTHORIZATION",
  service_call: "AUTHORIZATION",
  runtime_injection: "RUNTIME",
}

const SECTION_ORDER: SectionName[] = [
  "MIDDLEWARE CHAIN",
  "HANDLER",
  "VALIDATION",
  "AUTHORIZATION",
  "RUNTIME",
  "OTHER",
]

function groupBySemantic(nodes: ExecutionNode[]): Map<SectionName, ExecutionNode[]> {
  const map = new Map<SectionName, ExecutionNode[]>(
    SECTION_ORDER.map((s) => [s, []])
  )
  for (const node of nodes) {
    const section = NODE_SECTION[node.type] ?? "OTHER"
    map.get(section)!.push(node)
  }
  return map
}

// ---- Execution summary ------------------------------------------------

function buildExecutionSummary(nodes: ExecutionNode[]): string | null {
  const counts: Record<string, number> = {}
  for (const node of nodes) {
    if ((node.occurrenceCount ?? 1) > 1) {
      counts[node.type] = (counts[node.type] ?? 0) + (node.occurrenceCount ?? 1)
    }
  }
  const entries = Object.entries(counts)
  if (entries.length === 0) return null
  const parts = entries.map(([type, count]) => `${count}× ${type}`)
  return `[EXECUTION CHARACTERISTICS]\n  ${parts.join(", ")}`
}

// ---- Node formatting --------------------------------------------------

function formatNode(node: ExecutionNode): string {
  const args = node.args?.length ? ` [${node.args.join(", ")}]` : ""
  const role = node.role ? ` (${node.role})` : ""
  const count = (node.occurrenceCount ?? 1) > 1 ? ` ×${node.occurrenceCount}` : ""
  return `  → ${node.symbol}${args}${role}${count}`
}

import type { Finding } from "../findings/types.js"

function severityBadge(s: Finding["severity"]): string {
  const map: Record<Finding["severity"], string> = {
    CRITICAL: "🔴 CRITICAL",
    HIGH: "🟠 HIGH",
    MEDIUM: "🟡 MEDIUM",
    LOW: "🟢 LOW",
    INFO: "🔵 INFO",
  }
  return map[s]
}

function renderFinding(f: Finding, index: number): string {
  const lines: string[] = []

  lines.push(`## Finding ${index + 1}: ${f.type.replace(/_/g, " ").toUpperCase()}`)
  lines.push("")
  lines.push(`**Severity:** ${severityBadge(f.severity)}  `)
  lines.push(`**Confidence:** ${f.confidence}  `)
  lines.push(`**Nodes:** ${f.involvedNodes.join(", ")}`)
  lines.push("")
  lines.push(`### Summary`)
  lines.push(f.summary)
  lines.push("")

  if (f.evidence.length > 0) {
    lines.push(`### Evidence`)
    for (const e of f.evidence) {
      const detail = e.detail ? ` — \`${e.detail}\`` : ""
      lines.push(`- **${e.nodeId}**: ${e.description}${detail}`)
    }
    lines.push("")
  }

  if (f.reasoning.length > 0) {
    lines.push(`### Reasoning`)
    for (const step of f.reasoning) {
      const extras = Object.entries(step)
        .filter(([k]) => k !== "type")
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ")
      lines.push(`- \`${step.type}\`${extras ? `: ${extras}` : ""}`)
    }
    lines.push("")
  }

  if (f.uncertainty && f.uncertainty.length > 0) {
    lines.push(`### Uncertainty`)
    for (const u of f.uncertainty) {
      lines.push(`- ${u}`)
    }
    lines.push("")
  }

  if (f.recommendations && f.recommendations.length > 0) {
    lines.push(`### Recommendations`)
    for (const r of f.recommendations) {
      lines.push(`- ${r}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

export function renderMarkdown(findings: Finding[]): string {
  if (findings.length === 0) {
    return "# Analysis\n\nNo findings detected.\n"
  }

  const header = [
    "# Analysis",
    "",
    `${findings.length} finding(s) detected.`,
    "",
  ].join("\n")

  return header + findings.map(renderFinding).join("\n---\n\n")
}

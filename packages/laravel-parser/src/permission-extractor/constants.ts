import type { ExecutionNode } from "@archmind/protocol"
import type { ConstantMap } from "../constant-resolver.js"

export function extractPermissionNodes(
  map: ConstantMap,
  relativeFilePath: string
): ExecutionNode[] {
  const nodes: ExecutionNode[] = []

  for (const [className, constants] of Object.entries(map)) {
    for (const constName of Object.keys(constants)) {
      const id = `perm_${className.toLowerCase()}_${constName.toLowerCase()}`
      nodes.push({
        id,
        type: "permission",
        symbol: `${className}::${constName}`,
        file: relativeFilePath,
      })
    }
  }

  return nodes
}

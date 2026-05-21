import { join } from "path"
import type {
  IntermediateExecutionGraph,
  ExecutionNode,
  ExecutionEdge,
} from "@archmind/protocol"
import { parseControllerMethod } from "./controller-parser.js"

// ---- Public API -------------------------------------------------------

export interface AugmentOptions {
  projectRoot: string
}

/**
 * Augment a skeleton graph with L1 nodes (FormRequest, policy) by analysing
 * the controller method body. Requires the controller_action node to have a
 * `file` field pointing to the controller PHP file (relative to projectRoot).
 */
export function augmentGraph(
  graph: IntermediateExecutionGraph,
  opts: AugmentOptions
): IntermediateExecutionGraph {
  const ctrlNode = graph.nodes.find((n) => n.type === "controller_action")
  if (!ctrlNode?.file) return graph

  const [, methodName] = ctrlNode.symbol.split("::")
  if (!methodName) return graph

  const filePath = join(opts.projectRoot, ctrlNode.file)
  const l1 = parseControllerMethod(filePath, methodName)
  if (!l1) return graph

  const ctrlClass = ctrlNode.symbol.split("::")[0]
  const newNodes: ExecutionNode[] = [...graph.nodes]
  const newEdges: ExecutionEdge[]  = [...graph.edges]

  // FormRequest nodes — edge traceability: static (visible in method signature)
  for (const fr of l1.formRequests) {
    const id = `fr_${fr.shortName.toLowerCase().replace(/[^a-z0-9]/g, "_")}`
    newNodes.push({
      id,
      type:   "form_request",
      symbol: `${fr.shortName}::authorize`,
      role:   "validation",
    })
    newEdges.push({
      from:          ctrlNode.id,
      to:            id,
      relation:      "form_request",
      traceability:  "static",
    })
  }

  // Policy nodes — edge traceability: semantic (inferred from $this->authorize())
  for (const auth of l1.authorizeCalls) {
    const policyClass = inferPolicyClass(ctrlClass)
    const id = `policy_${policyClass.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${auth.ability}`
    newNodes.push({
      id,
      type:   "policy",
      symbol: `${policyClass}::${auth.ability}`,
      role:   "authorization",
    })
    newEdges.push({
      from:          ctrlNode.id,
      to:            id,
      relation:      "policy_check",
      traceability:  "semantic",
      mechanism:     auth.mechanism,
    })
  }

  return { ...graph, nodes: newNodes, edges: newEdges }
}

// ---- PSR-4 helpers ----------------------------------------------------

/**
 * Convert App\ FQCN to a relative file path.
 * App\Modules\Task\Http\Controllers\TaskController → app/Modules/Task/Http/Controllers/TaskController.php
 */
export function fqcnToRelativePath(fqcn: string): string {
  return fqcn.replace(/^App\\/, "app/").replace(/\\/g, "/") + ".php"
}

// ---- Policy inference -------------------------------------------------

/**
 * Infer policy class name from controller class name.
 * TaskController → TaskPolicy, UserController → UserPolicy
 */
function inferPolicyClass(controllerClass: string): string {
  const m = controllerClass.match(/^(.+)Controller$/)
  return m ? `${m[1]}Policy` : `${controllerClass}Policy`
}

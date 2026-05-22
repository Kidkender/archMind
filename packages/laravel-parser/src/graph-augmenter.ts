import { join } from "path"
import type {
  IntermediateExecutionGraph,
  ExecutionNode,
  ExecutionEdge,
} from "@archmind/protocol"
import { parseControllerMethod, type ServiceCall } from "./controller-parser.js"

// ---- Public API -------------------------------------------------------

export interface AugmentOptions {
  projectRoot: string
}

/**
 * Augment a skeleton graph with L1 nodes (FormRequest, policy) by analysing
 * the controller method body. Requires the controller_action node to have a
 * `file` field pointing to the controller PHP file (relative to projectRoot).
 *
 * Also extracts service_call nodes from:
 * - The controller action method
 * - Middleware nodes that have a file field (parses their handle() method)
 * - Policy nodes added during augmentation (file inferred from class name)
 */
export function augmentGraph(
  graph: IntermediateExecutionGraph,
  opts: AugmentOptions
): IntermediateExecutionGraph {
  const newNodes: ExecutionNode[] = [...graph.nodes]
  const newEdges: ExecutionEdge[]  = [...graph.edges]

  // ---- Controller L1 pass ------------------------------------------
  const ctrlNode = graph.nodes.find((n) => n.type === "controller_action")
  if (ctrlNode?.file) {
    const [ctrlClass, methodName] = ctrlNode.symbol.split("::")
    if (methodName) {
      const filePath = join(opts.projectRoot, ctrlNode.file)
      const l1 = parseControllerMethod(filePath, methodName)
      if (l1) {
        // FormRequest nodes
        for (const fr of l1.formRequests) {
          const id = `fr_${fr.shortName.toLowerCase().replace(/[^a-z0-9]/g, "_")}`
          newNodes.push({
            id,
            type:   "form_request",
            symbol: `${fr.shortName}::authorize`,
            role:   "validation",
          })
          newEdges.push({
            from:         ctrlNode.id,
            to:           id,
            relation:     "form_request",
            traceability: "static",
          })
        }

        // Policy nodes — include inferred file so they can be augmented below
        const addedPolicyNodes: ExecutionNode[] = []
        for (const auth of l1.authorizeCalls) {
          const policyClass = inferPolicyClass(ctrlClass ?? "")
          const policyFile  = `app/Policies/${policyClass}.php`
          const id = `policy_${policyClass.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${auth.ability}`
          const policyNode: ExecutionNode = {
            id,
            type:   "policy",
            symbol: `${policyClass}::${auth.ability}`,
            role:   "authorization",
            file:   policyFile,
          }
          newNodes.push(policyNode)
          addedPolicyNodes.push(policyNode)
          newEdges.push({
            from:         ctrlNode.id,
            to:           id,
            relation:     "policy_check",
            traceability: "semantic",
            mechanism:    auth.mechanism,
          })
        }

        // Service calls from controller action
        addServiceCallNodes(newNodes, newEdges, ctrlNode.id, l1.serviceCalls, opts.projectRoot)

        // Service calls from policy methods
        for (const policyNode of addedPolicyNodes) {
          if (!policyNode.file) continue
          const [, policyMethod] = policyNode.symbol.split("::")
          if (!policyMethod) continue
          const policyL1 = parseControllerMethod(
            join(opts.projectRoot, policyNode.file),
            policyMethod
          )
          if (policyL1) {
            addServiceCallNodes(newNodes, newEdges, policyNode.id, policyL1.serviceCalls, opts.projectRoot)
          }
        }
      }
    }
  }

  // ---- Middleware service_call pass ------------------------------------
  const mwTypes = new Set(["middleware", "authorization_check", "authentication_gate"])
  for (const mwNode of graph.nodes) {
    if (!mwTypes.has(mwNode.type) || !mwNode.file) continue
    const filePath = join(opts.projectRoot, mwNode.file)
    const l1 = parseControllerMethod(filePath, "handle")
    if (l1) {
      addServiceCallNodes(newNodes, newEdges, mwNode.id, l1.serviceCalls, opts.projectRoot)
    }
  }

  return { ...graph, nodes: newNodes, edges: newEdges }
}

// ---- PSR-4 helpers ----------------------------------------------------

export function fqcnToRelativePath(fqcn: string): string {
  return fqcn.replace(/^App\\/, "app/").replace(/\\/g, "/") + ".php"
}

// ---- Helpers ----------------------------------------------------------

function inferPolicyClass(controllerClass: string): string {
  const m = controllerClass.match(/^(.+)Controller$/)
  return m ? `${m[1]}Policy` : `${controllerClass}Policy`
}

/**
 * Add service_call nodes and their edges from a parsed method's service calls.
 * Each node ID is scoped to the caller to allow the same service to be called
 * from multiple places (e.g. CheckPermission AND TaskPolicy both call hasPermission).
 */
function addServiceCallNodes(
  nodes: ExecutionNode[],
  edges: ExecutionEdge[],
  callerNodeId: string,
  serviceCalls: ServiceCall[],
  projectRoot: string
): void {
  const seen = new Set<string>()

  for (const sc of serviceCalls) {
    // Scope ID by caller so same service called from different nodes creates separate nodes
    const idBase = `svc_${sc.serviceClass}_${sc.method}`.toLowerCase().replace(/[^a-z0-9]/g, "_")
    const id     = `${idBase}_${callerNodeId.replace(/[^a-z0-9]/g, "_")}`

    if (seen.has(id)) continue
    seen.add(id)

    const file = sc.serviceFqcn.includes("\\") ? fqcnToRelativePath(sc.serviceFqcn) : undefined

    nodes.push({
      id,
      type:   "service_call",
      symbol: `${sc.serviceClass}::${sc.method}`,
      role:   "service",
      ...(file             ? { file }      : {}),
      ...(sc.args.length > 0 ? { args: sc.args } : {}),
    })

    edges.push({
      from:         callerNodeId,
      to:           id,
      relation:     "calls",
      traceability: "semantic",
    })
  }

  // suppress unused import warning — projectRoot used for future extension
  void projectRoot
}

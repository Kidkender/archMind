import type { SemanticFact } from "../fact-extraction/types.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import { query } from "@kidkender/archmind-graph-query"
import type { Finding, Evidence, ReasoningStep } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { stableHash } from "../findings/stable-hash.js"

interface UnscopedQueryGroup {
  unscopedNodeId: string
  unscopedSymbol: string
  injectionNodeId: string
}

function findUnscopedGroups(graph: IntermediateExecutionGraph): UnscopedQueryGroup[] {
  const q = query(graph)
  // missing_tenant_scope edges: unscoped_query → the node that resolves the tenant
  // (runtime_injection in Laravel graphs, ir:tenant_context in Gin graphs)
  const missingEdges = q.edges().ofRelation("missing_tenant_scope")
  const groups: UnscopedQueryGroup[] = []

  for (const edge of missingEdges.toArray()) {
    const unscopedNode  = missingEdges.from(edge.from).fromNodes().ofType("unscoped_query").first()
    const injectionNode = missingEdges.to(edge.to).toNodes()
      .ofType(IR_NODE_TYPES.RUNTIME_INJECT, IR_NODE_TYPES.TENANT_CONTEXT).first()
    if (!unscopedNode || !injectionNode) continue
    groups.push({
      unscopedNodeId:  unscopedNode.id,
      unscopedSymbol:  unscopedNode.symbol,
      injectionNodeId: injectionNode.id,
    })
  }

  return groups
}

export function detectMissingTenantScope(
  _facts: SemanticFact[],
  graph: IntermediateExecutionGraph
): Finding[] {
  const q = query(graph)

  // Fast guards: need both tenant context and unscoped access to fire
  if (!q.data().hasTenantContext()) return []
  if (!q.data().hasUnscopedAccess()) return []

  const groups   = findUnscopedGroups(graph)
  const findings: Finding[] = []

  for (const group of groups) {
    const supportingNodes = [group.unscopedNodeId, group.injectionNodeId]

    const reasoning: ReasoningStep[] = [
      {
        type:        "tenant_context_present",
        node:        group.injectionNodeId,
        description: graph.framework === "gin"
          ? "Tenant is resolved for this request — this is a tenant-scoped route"
          : "Tenant is resolved and injected into the container — this is a tenant-scoped route",
      },
      {
        type:        "unscoped_query_detected",
        node:        group.unscopedNodeId,
        symbol:      group.unscopedSymbol,
        description: "Model query executes without a tenant constraint — returns rows from any tenant",
      },
      {
        type:        "boundary_violation",
        description: "An authenticated user can access another tenant's data by supplying a valid but cross-tenant ID",
      },
    ]

    const [modelClass, operation] = group.unscopedSymbol.split("::")

    const evidence: Evidence[] = [
      {
        nodeId:      group.injectionNodeId,
        description: graph.framework === "gin"
          ? "Tenant resolved for this request — confirms this route is tenant-scoped"
          : "Tenant injected into container — confirms this route is tenant-scoped",
      },
      {
        nodeId:      group.unscopedNodeId,
        description: `${group.unscopedSymbol} fetches by ID with no tenant constraint`,
        detail:      "Raw ID lookup across all tenants — authorization (policy) only checks permission, not tenancy",
      },
    ]

    findings.push({
      id:         `${FINDING_TYPES.MISSING_TENANT_SCOPE}-${stableHash(supportingNodes)}`,
      type:       FINDING_TYPES.MISSING_TENANT_SCOPE,
      severity:   "CRITICAL",
      confidence: "HIGH",
      provenance: {
        detector:            FINDING_TYPES.MISSING_TENANT_SCOPE,
        ontology_primitives: ["UnscopedQuery", "TenantBoundaryViolation", "GlobalScopeAssumption"],
        supporting_nodes:    supportingNodes,
        supporting_edges:    graph.edges
          .filter(
            (e) =>
              e.relation === "missing_tenant_scope" &&
              (supportingNodes.includes(e.from) || supportingNodes.includes(e.to))
          )
          .map((e) => `${e.from}:${e.relation}:${e.to}`),
      },
      summary: `${group.unscopedSymbol} fetches by raw ID with no tenant constraint — any authenticated user can access another tenant's ${modelClass ?? "model"} by guessing the ID`,
      reasoning,
      evidence,
      ...(graph.framework === "gin" ? ginAdvice(modelClass, operation) : laravelAdvice(modelClass, operation)),
    })
  }

  return findings
}

type Advice = Pick<Finding, "uncertainty" | "recommendations">

function laravelAdvice(modelClass: string | undefined, operation: string | undefined): Advice {
  return {
    uncertainty: [
      {
        kind:        "unverifiable_condition",
        description: `If ${modelClass} has a registered global TenantScope (via booted() or AppServiceProvider), ${operation ?? "find"} is automatically scoped and this finding does not apply — global scopes are not visible at the call site`,
      },
    ],
    recommendations: [
      `Option A: ${modelClass}::where('tenant_id', app('tenant')->id)->${operation ?? "findOrFail"}($id)`,
      `Option B: Add a global TenantScope to ${modelClass}'s booted() method`,
      `Option C: Use scoped route model binding in AppServiceProvider`,
    ],
  }
}

function ginAdvice(modelClass: string | undefined, operation: string | undefined): Advice {
  const model = modelClass && modelClass !== "gorm" ? modelClass : "the model"
  return {
    uncertainty: [
      {
        kind:        "unverifiable_condition",
        description: `If ${model} is scoped by a GORM callback, a plugin or a Scopes() function that does not name the tenant, ${operation ?? "the query"} may already be constrained — those are not visible at the call site`,
      },
    ],
    recommendations: [
      `Option A: add the tenant to the query, e.g. db.Where("tenant_id = ?", tenantID).${operation ?? "First"}(...)`,
      `Option B: a reusable scope, e.g. db.Scopes(TenantScope(tenantID)).${operation ?? "First"}(...)`,
      `Option C: register a GORM callback that adds the tenant condition to every query on ${model}`,
    ],
  }
}

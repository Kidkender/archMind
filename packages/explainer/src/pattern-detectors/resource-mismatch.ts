import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { IR_NODE_TYPES, IR_EDGE_RELATIONS } from "@kidkender/archmind-protocol"
import { query } from "@kidkender/archmind-graph-query"
import type { Finding } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { stableHash } from "../findings/stable-hash.js"

/**
 * Detects two resource-level authorization failures (IR v1.1):
 *
 * RESOURCE_MISMATCH — an AUTHZ_CHECK authorizes Resource(A) but the
 * BUSINESS_HANDLER accesses Resource(B) where A ≠ B.
 *
 * RESOURCE_UNPROTECTED — a BUSINESS_HANDLER accesses Resource(X) via
 * route-model-binding but no AUTHZ_CHECK has an `authorizes` edge to Resource(X).
 *
 * Both detectors run on IR — they are framework-agnostic.
 */

interface ResourceRef {
  nodeId:    string
  className: string
}

function getAuthorizedResources(graph: IntermediateExecutionGraph): ResourceRef[] {
  const q = query(graph)
  return q.edges().ofRelation(IR_EDGE_RELATIONS.AUTHORIZES).toNodes()
    .ofType(IR_NODE_TYPES.RESOURCE).toArray()
    .map((n) => ({ nodeId: n.id, className: n.symbol }))
}

function getAccessedResources(graph: IntermediateExecutionGraph): ResourceRef[] {
  const q = query(graph)
  return q.edges().ofRelation(IR_EDGE_RELATIONS.ACCESSES).toNodes()
    .ofType(IR_NODE_TYPES.RESOURCE).toArray()
    .map((n) => ({ nodeId: n.id, className: n.symbol }))
}

export function detectResourceMismatch(
  graph: IntermediateExecutionGraph
): Finding[] {
  if (!query(graph).data().resources().exists()) return []

  const authorized = getAuthorizedResources(graph)
  const accessed   = getAccessedResources(graph)

  if (accessed.length === 0) return []

  const findings: Finding[] = []
  const authorizedClasses = new Set(authorized.map((r) => r.className))

  const ctrlNode = query(graph).nodes().ofType(IR_NODE_TYPES.BUSINESS_HANDLER).first()

  // RESOURCE_UNPROTECTED: accessed resource has no matching authorizes edge.
  //
  // Only claimed when the route has no authorization of any kind. An authz
  // check that isn't wired to this resource (a permission helper, a service
  // rule, FormRequest::authorize(), a role middleware) may well cover it — we
  // can't prove it doesn't, and RESOURCE_MISMATCH below handles the provable case.
  const q = query(graph)
  const anyAuthorization = q.security().hasAuthorization()
  const authenticated = q.security().authenticationGates().exists()
  // An authenticated mutation with no authorization is already reported, with
  // the same evidence, by missing_authorization — don't report it twice.
  const coveredByMissingAuthorization = authenticated && q.isMutation()
  // A signed URL (Laravel `signed` middleware) is a capability: only someone
  // holding the link the app generated can load the record.
  const signedUrl = graph.nodes.some((n) => n.type === "signature_check")
  const unprotectedCandidates = anyAuthorization || coveredByMissingAuthorization || signedUrl ? [] : accessed

  for (const acc of unprotectedCandidates) {
    if (authorizedClasses.has(acc.className)) continue

    const evidence = [
      {
        nodeId: acc.nodeId,
        description: `${acc.className} is accessed (route-model-binding) but no authorization check targets this resource`,
      },
    ]
    if (ctrlNode) {
      evidence.push({
        nodeId: ctrlNode.id,
        description: `${ctrlNode.symbol} accesses ${acc.className} without a policy or Gate check covering ${acc.className}`,
      })
    }

    findings.push({
      id: `${FINDING_TYPES.RESOURCE_UNPROTECTED}-${stableHash([acc.nodeId, graph.entrypoint ?? ""])}`,
      type: FINDING_TYPES.RESOURCE_UNPROTECTED,
      // CRITICAL only when anyone, not logged in, can reach the record by ID;
      // behind a login it is an IDOR risk among authenticated users.
      severity: authenticated ? "HIGH" : "CRITICAL",
      confidence: "HIGH",
      provenance: {
        detector: FINDING_TYPES.RESOURCE_UNPROTECTED,
        ontology_primitives: ["Resource", "BusinessHandler"],
        supporting_nodes: [acc.nodeId, ...(ctrlNode ? [ctrlNode.id] : [])],
        supporting_edges: graph.edges
          .filter((e) => e.to === acc.nodeId || e.from === acc.nodeId)
          .map((e) => `${e.from}:${e.relation}:${e.to}`),
      },
      summary: authenticated
        ? `${acc.className} is loaded by ID with no authorization check — any logged-in user can reach any ${acc.className}`
        : `${acc.className} is loaded by ID on a public route with no authentication or authorization`,
      reasoning: [
        {
          type: "resource_accessed",
          className: acc.className,
          note: "Route-model-binding injects resource directly into controller method",
        },
        {
          type: "no_authorizes_edge",
          note: `No AUTHZ_CHECK has an '${IR_EDGE_RELATIONS.AUTHORIZES}' edge to ${acc.className}`,
        },
      ],
      evidence,
      recommendations: [
        `Add $this->authorize('update', $${acc.className.toLowerCase()}) in the controller method`,
        `Create a ${acc.className}Policy with an 'update' method and register it in AuthServiceProvider`,
        `Or add a Gate::authorize('update', $${acc.className.toLowerCase()}) check before the business logic`,
      ],
    })
  }

  // RESOURCE_MISMATCH: authorized resource differs from accessed resource
  if (authorized.length > 0 && accessed.length > 0) {
    const accessedClasses = new Set(accessed.map((r) => r.className))
    for (const auth of authorized) {
      if (accessedClasses.has(auth.className)) continue

      // authorized A ≠ any accessed resource — this is a mismatch
      for (const acc of accessed) {
        const authzNode = query(graph).edges()
          .ofRelation(IR_EDGE_RELATIONS.AUTHORIZES).to(auth.nodeId)
          .fromNodes().first()

        findings.push({
          id: `${FINDING_TYPES.RESOURCE_MISMATCH}-${stableHash([auth.nodeId, acc.nodeId])}`,
          type: FINDING_TYPES.RESOURCE_MISMATCH,
          severity: "CRITICAL",
          confidence: "HIGH",
          provenance: {
            detector: FINDING_TYPES.RESOURCE_MISMATCH,
            ontology_primitives: ["Resource", "AuthzCheck", "BusinessHandler"],
            supporting_nodes: [auth.nodeId, acc.nodeId, ...(authzNode ? [authzNode.id] : [])],
            supporting_edges: graph.edges
              .filter((e) => e.to === auth.nodeId || e.to === acc.nodeId)
              .map((e) => `${e.from}:${e.relation}:${e.to}`),
          },
          summary: `Authorization covers ${auth.className} but the handler accesses ${acc.className} — resource mismatch`,
          reasoning: [
            {
              type: "authorizes_resource",
              className: auth.className,
              note: `AUTHZ_CHECK authorizes ${auth.className}`,
            },
            {
              type: "accesses_different_resource",
              className: acc.className,
              note: `BUSINESS_HANDLER accesses ${acc.className} — a different resource`,
            },
          ],
          evidence: [
            {
              nodeId: auth.nodeId,
              description: `Authorization check covers ${auth.className}, not ${acc.className}`,
            },
            {
              nodeId: acc.nodeId,
              description: `${acc.className} is accessed without a matching authorization check`,
            },
          ],
          recommendations: [
            `Change the authorization to target ${acc.className}: $this->authorize('update', $${acc.className.toLowerCase()})`,
            `Or create a ${acc.className}Policy to handle authorization for this resource`,
          ],
        })
      }
    }
  }

  return findings
}

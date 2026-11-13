import { IR_NODE_TYPES, IR_EDGE_RELATIONS, IR_VERSION } from "@kidkender/archmind-protocol"
import type { IntermediateExecutionGraph, ExecutionNode, ExecutionEdge } from "@kidkender/archmind-protocol"
import type { RouteInfo, MiddlewareRef, GoSourceFile } from "./route-parser.js"
import { extractRoutes, type ExtractRoutesOptions } from "./route-parser.js"
import { irTypeForMiddleware, resolveSkipListForMiddleware, type SkipEntry } from "./middleware-mapper.js"
import { parseGo, findFunctionDecls, functionName, callParts, findCalls, receiverTypeName, type SyntaxNode } from "./ast.js"
import { buildConstRegistry, resolveConstExpr } from "./const-resolver.js"
import { buildMethodRegistry, findBindCalls, resolveVarDtoType, type HandlerMethod } from "./handler-parser.js"
import { resolveDtoBinding, findStructFieldTypes } from "./dto-binding-parser.js"
import { findTransactionBoundaries } from "./transaction-parser.js"
import { buildCodeIndex, resolveReceiverType, isDataType, modelHasTenantField, type CodeIndex } from "./code-index.js"
import {
  findTenantContextRead, findGormOperations, tokenMatcher, daoCall, variadicParamNames, type DataAccessContext,
  DEFAULT_TENANT_SIGNALS, DEFAULT_TENANT_CONTEXT_KEYS,
  type IsolationOptions, type TokenMatcher, type GormOperation,
} from "./isolation-parser.js"

const ADAPTER_VERSION = "0.1.0"

export interface ParseGinOptions extends ExtractRoutesOptions {
  /**
   * Names of the functions that resolve the calling user's own record (e.g.
   * "currentCharacter"). A handler that calls one of them is treated as
   * authorizing by ownership — for self-service APIs that scope every query
   * to the caller instead of checking a role.
   */
  ownershipSources?: string[]
  /** Tenant isolation signals (archmind.json `isolation`); defaults cover tenant_id / organization_id. */
  isolation?: IsolationOptions
}

interface ParsedFile {
  path: string
  root: SyntaxNode
}

function buildSkipListIndex(parsed: ParsedFile[], middlewareNames: Set<string>): Map<string, SkipEntry[]> {
  const functionsByName = new Map<string, SyntaxNode>()
  for (const file of parsed) {
    for (const fn of findFunctionDecls(file.root)) {
      const name = functionName(fn)
      if (name) functionsByName.set(name, fn)
    }
  }

  const index = new Map<string, SkipEntry[]>()
  for (const name of middlewareNames) {
    index.set(name, resolveSkipListForMiddleware(name, functionsByName))
  }
  return index
}

function isExempt(route: RouteInfo, skipList: SkipEntry[]): boolean {
  return skipList.some((e) => e.method === route.method && e.path === route.path)
}

function middlewareNode(
  mw: MiddlewareRef,
  idx: number,
  skipListIndex: Map<string, SkipEntry[]>,
  route: RouteInfo,
  constRegistry: Map<string, string>
): ExecutionNode | null {
  const type = irTypeForMiddleware(mw.shortName)

  // A globally-applied auth middleware with a matching skip-list entry means
  // this specific route is exempt — don't emit the auth_gate node for it,
  // same way an unmatched entry means the gate genuinely applies.
  if (type === IR_NODE_TYPES.AUTH_GATE) {
    const skipList = skipListIndex.get(mw.shortName) ?? []
    if (isExempt(route, skipList)) return null
  }

  // Resolve role/permission const identifiers (e.g. "model.RoleAdmin") to
  // their declared literal value where possible — same intent as Laravel's
  // Permission::TASK_DELETE constant resolution.
  const resolvedArgs = mw.args.map((a) => resolveConstExpr(a, constRegistry))

  return {
    id:     `mw_${idx}`,
    type,
    symbol: mw.text,
    file:   mw.file,
    line:   mw.line,
    args:   resolvedArgs.length > 0 ? resolvedArgs : undefined,
    role:   type === IR_NODE_TYPES.AUTH_GATE ? "authentication" : type === IR_NODE_TYPES.AUTHZ_CHECK ? "authorization" : "middleware",
  }
}

/** Resolves a route's handler method declaration from its receiver type + method name, when known. */
function resolveHandlerMethod(
  route: RouteInfo,
  methodRegistry: ReturnType<typeof buildMethodRegistry>
): HandlerMethod | null {
  if (!route.handlerReceiverType) return null
  const methodShortName = route.handlerText.slice(route.handlerText.lastIndexOf(".") + 1)
  return methodRegistry.get(`${route.handlerReceiverType}.${methodShortName}`) ?? null
}

/**
 * Resolves the ir:validation_gate node for a route, when its handler is
 * known (handlerReceiverType set) and that handler method calls one of the
 * ShouldBind family on a locally-declared DTO struct. Returns null whenever
 * any step of that chain doesn't resolve — validation-gate detection is
 * best-effort, not required for a route to have a correct graph otherwise.
 */
function validationGateNode(
  route: RouteInfo,
  methodRegistry: ReturnType<typeof buildMethodRegistry>,
  parsed: ParsedFile[]
): ExecutionNode | null {
  const method = resolveHandlerMethod(route, methodRegistry)
  if (!method) return null

  const body = method.node.childForFieldName("body")
  if (!body) return null

  const [bindCall] = findBindCalls(body)
  if (!bindCall) return null

  const dtoType = resolveVarDtoType(body, bindCall.varName)
  if (!dtoType) return null

  const binding = resolveDtoBinding(dtoType, parsed)
  if (!binding || binding.fields.length === 0) return null

  const rules = binding.fields
    .filter((f) => f.bindingTag)
    .map((f) => `${f.name}:${f.bindingTag}`)

  return {
    id:     "validation",
    type:   IR_NODE_TYPES.VALIDATION_GATE,
    symbol: dtoType,
    file:   binding.file,
    role:   "validation",
    args:   rules.length > 0 ? rules : undefined,
    detail: `bound via ctx.${bindCall.kind === "json" ? "ShouldBindJSON" : bindCall.kind === "query" ? "ShouldBindQuery" : "ShouldBindUri"}`,
  }
}

/**
 * Resolves the ir:txn_boundary node for a route. Checks the handler method's
 * own body first (rare in the surveyed repos — handlers are thin), then
 * follows one hop into a directly-called service method (`h.someService.Method(...)`,
 * resolved via the handler struct's own field types) since all 3 surveyed
 * repos put GORM transactions in the service layer, never the handler
 * itself. Only that single hop is followed — matches the plan's stated v1
 * scope (handler-level + one hop, not full recursive service-call
 * expansion). Presence-only detection (v1): doesn't yet determine which
 * specific downstream mutations fall inside the transaction, the same
 * transaction-scope-flattening gap the README documents for the Laravel IR.
 */
function transactionBoundaryNode(
  route: RouteInfo,
  methodRegistry: ReturnType<typeof buildMethodRegistry>,
  parsed: ParsedFile[]
): ExecutionNode | null {
  const method = resolveHandlerMethod(route, methodRegistry)
  if (!method || !route.handlerReceiverType) return null
  const body = method.node.childForFieldName("body")
  if (!body) return null

  const direct = findTransactionBoundaries(body)
  if (direct.length > 0) {
    return {
      id:     "txn",
      type:   IR_NODE_TYPES.TXN_BOUNDARY,
      symbol: route.handlerText,
      file:   method.file,
      line:   direct[0].line,
      role:   "transaction",
    }
  }

  let fieldTypes: Map<string, string> | null = null
  for (const file of parsed) {
    fieldTypes = findStructFieldTypes(file.root, route.handlerReceiverType)
    if (fieldTypes) break
  }
  if (!fieldTypes) return null

  for (const node of findCalls(body)) {
    const parts = callParts(node)
    if (!parts?.receiver) continue
    const fieldName = parts.receiver.slice(parts.receiver.lastIndexOf(".") + 1)
    const serviceType = fieldTypes.get(fieldName)
    if (!serviceType) continue

    const serviceMethod = methodRegistry.get(`${serviceType}.${parts.method}`)
    const serviceBody = serviceMethod?.node.childForFieldName("body")
    if (!serviceBody) continue

    const found = findTransactionBoundaries(serviceBody)
    if (found.length > 0) {
      return {
        id:     "txn",
        type:   IR_NODE_TYPES.TXN_BOUNDARY,
        symbol: `${serviceType}.${parts.method}`,
        file:   serviceMethod!.file,
        line:   found[0].line,
        role:   "transaction",
      }
    }
  }
  return null
}

/**
 * Resolves the ir:authz_check node for ownership authorization: the handler
 * method calls one of the configured identity-resolving functions, either in
 * its own body or — one hop — in a helper method on the same receiver
 * (`h.respond(c, ...)`), the way handlers that share a prologue are written.
 * A handler that never resolves the caller (e.g. one that acts on a URL `:id`)
 * gets no node, which is what keeps the missing_authorization finding
 * meaningful.
 */
function ownershipCheckNode(
  route: RouteInfo,
  methodRegistry: ReturnType<typeof buildMethodRegistry>,
  sources: ReadonlySet<string>
): ExecutionNode | null {
  if (sources.size === 0) return null
  const method = resolveHandlerMethod(route, methodRegistry)
  if (!method) return null

  const direct = findIdentityCall(method, sources)
  if (direct) return direct

  const body = method.node.childForFieldName("body")
  if (!body || !route.handlerReceiverType) return null
  for (const node of findCalls(body)) {
    const parts = callParts(node)
    // `h.helper(...)`: a single-identifier receiver, resolved on the same type.
    if (!parts?.receiver || parts.receiver.includes(".")) continue
    const helper = methodRegistry.get(`${route.handlerReceiverType}.${parts.method}`)
    const found = helper && helper !== method ? findIdentityCall(helper, sources) : null
    if (found) return found
  }
  return null
}

/** The ownership node for the first configured identity call in a method's own body. */
function findIdentityCall(method: HandlerMethod, sources: ReadonlySet<string>): ExecutionNode | null {
  const body = method.node.childForFieldName("body")
  if (!body) return null
  for (const node of findCalls(body)) {
    const parts = callParts(node)
    if (!parts || !sources.has(parts.method)) continue
    return {
      id:     "ownership",
      type:   IR_NODE_TYPES.AUTHZ_CHECK,
      symbol: `ownership:${parts.method}`,
      file:   method.file,
      line:   node.startPosition.row + 1,
      role:   "authorization",
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

interface IsolationContext {
  methodRegistry: ReturnType<typeof buildMethodRegistry>
  fieldTypesOf:   (typeName: string) => Map<string, string>
  keyMatch:       TokenMatcher
  signalMatch:    TokenMatcher
  codeIndex:      CodeIndex
  /** GORM callbacks registered by the project whose function sets or filters the tenant. */
  tenantHooks:    ReadonlySet<"create" | "update" | "delete" | "query">
}

/** A method on a request's path, with the argument text of the call that reached it. */
interface PathEntry {
  method:     HandlerMethod
  callerArgs: string
}

/** How far below the handler queries are looked for: handler → service → repository. */
const ISOLATION_MAX_DEPTH = 2
/** Query nodes kept per route, so one huge handler cannot flood the graph. */
const ISOLATION_MAX_QUERIES = 25

/** A method by receiver type, falling back to the usual implementation names of an interface. */
function resolveMethod(
  methodRegistry: ReturnType<typeof buildMethodRegistry>,
  typeName: string,
  methodName: string
): HandlerMethod | null {
  const lower = typeName.charAt(0).toLowerCase() + typeName.slice(1)
  const candidates = [typeName, lower, `${typeName}Impl`, `${lower}Impl`, typeName.replace(/^I(?=[A-Z])/, "")]
  for (const t of candidates) {
    const m = methodRegistry.get(`${t}.${methodName}`)
    if (m) return m
  }
  return null
}

function receiverName(fn: SyntaxNode): string | null {
  const decl = fn.childForFieldName("receiver")?.namedChildren.find((c) => c.type === "parameter_declaration")
  return decl?.namedChildren.find((c) => c.type === "identifier")?.text ?? null
}

function dataAccessContext(m: HandlerMethod, callerArgs: string, ctx: IsolationContext): DataAccessContext {
  return {
    resolveType: (receiver) => resolveReceiverType(m, receiver, ctx.fieldTypesOf, ctx.codeIndex),
    isDataType:  (t) => isDataType(t, ctx.codeIndex),
    calleeOf:    (t, name) => resolveMethod(ctx.methodRegistry, t, name),
    passedParams: variadicParamNames(m.node),
    callerArgs,
    tenantHooks: ctx.tenantHooks,
  }
}

/**
 * The handler plus the methods it reaches, up to ISOLATION_MAX_DEPTH: through
 * its receiver and struct fields (`s.repo.Find`), locals and parameters of a
 * known type (`db := dal.BoardQuery{}`), and package-level variables
 * (`service.GroupApp.Board.CreateBoard`). A read/write call on a DAO or model
 * wrapper is recorded where it is made (its arguments carry the scope), so the
 * generic wrapper behind it is not followed.
 */
function methodsOnPath(handler: HandlerMethod, ctx: IsolationContext): PathEntry[] {
  const out: PathEntry[] = []
  const seen = new Set<SyntaxNode>()
  let frontier: PathEntry[] = [{ method: handler, callerArgs: "" }]
  for (let depth = 0; depth <= ISOLATION_MAX_DEPTH && frontier.length > 0; depth++) {
    const next: PathEntry[] = []
    for (const entry of frontier) {
      const m = entry.method
      if (seen.has(m.node)) continue
      seen.add(m.node)
      out.push(entry)
      const body = m.node.childForFieldName("body")
      if (!body) continue
      const data = dataAccessContext(m, "", ctx)
      for (const call of findCalls(body)) {
        const parts = callParts(call)
        if (!parts?.receiver) continue
        const target = resolveReceiverType(m, parts.receiver, ctx.fieldTypesOf, ctx.codeIndex)
        if (!target || daoCall(call, body, data, ctx.signalMatch)?.leaf) continue
        const callee = resolveMethod(ctx.methodRegistry, target, parts.method)
        if (callee && !seen.has(callee.node)) {
          next.push({ method: callee, callerArgs: parts.args.map((a) => a.text).join(", ") })
        }
      }
    }
    frontier = next
  }
  return out
}

/**
 * Tenant isolation nodes for a route, the Go counterpart of laravel-parser's
 * addIsolationNodes. Emitted only when the route resolves a tenant — a tenant
 * middleware on the route, or a tenant read from the Gin context or an accessor
 * in the handler or a method it reaches — so single-tenant apps get no query
 * nodes (ir:unscoped_query is a topology danger type; emitting it everywhere
 * would turn every existing Gin baseline into drift). Each GORM query on the
 * path becomes ir:scoped_query or ir:unscoped_query / ir:unscoped_write, and an
 * unscoped one gets a missing_tenant_scope edge to the tenant node.
 */
function isolationGraphPart(
  route: RouteInfo,
  ctx: IsolationContext
): { nodes: ExecutionNode[]; edges: ExecutionEdge[] } {
  const handler = resolveHandlerMethod(route, ctx.methodRegistry)
  if (!handler) return { nodes: [], edges: [] }
  const path = methodsOnPath(handler, ctx)

  let tenantNode: ExecutionNode | null = null
  const tenantMiddleware = route.middleware.find((mw) => ctx.keyMatch(mw.shortName))
  if (tenantMiddleware) {
    tenantNode = {
      id: "tenant_ctx", type: IR_NODE_TYPES.TENANT_CONTEXT, symbol: `tenant context: ${tenantMiddleware.text}`,
      file: tenantMiddleware.file, line: tenantMiddleware.line, role: "runtime",
    }
  }
  for (const { method: m } of path) {
    if (tenantNode) break
    const read = findTenantContextRead(m, ctx.keyMatch)
    if (read) {
      tenantNode = {
        id: "tenant_ctx", type: IR_NODE_TYPES.TENANT_CONTEXT, symbol: `tenant context: ${read.symbol}`,
        file: read.file, line: read.line, role: "runtime",
      }
    }
  }
  if (!tenantNode) return { nodes: [], edges: [] }

  const ops: GormOperation[] = []
  for (const { method: m, callerArgs } of path) {
    const recvType = receiverTypeName(m.node)
    ops.push(...findGormOperations(m, recvType ? ctx.fieldTypesOf(recvType) : new Map(), ctx.signalMatch, dataAccessContext(m, callerArgs, ctx)))
  }

  const nodes: ExecutionNode[] = [tenantNode]
  const edges: ExecutionEdge[] = []
  let index = 0
  for (const op of ops) {
    if (index >= ISOLATION_MAX_QUERIES) break
    if (op.kind === "write" && op.scoped) continue   // like Laravel: only unscoped writes become nodes
    // an unscoped query only misses a tenant on a model whose rows carry one;
    // shared tables declared in the project without a tenant field (menus, the tenants table) are not reported
    if (!op.scoped && !modelHasTenantField(op.model, ctx.codeIndex, ctx.signalMatch)) continue
    const type = op.scoped
      ? IR_NODE_TYPES.SCOPED_QUERY
      : op.kind === "write" ? IR_NODE_TYPES.UNSCOPED_WRITE : IR_NODE_TYPES.UNSCOPED_QUERY
    const id = `iso_${index++}`
    nodes.push({ id, type, symbol: `${op.model}::${op.operation}`, file: op.file, line: op.line, role: "data_access" })
    edges.push({ from: "handler", to: id, relation: "calls", traceability: "static" })
    if (!op.scoped) {
      edges.push({ from: id, to: tenantNode.id, relation: "missing_tenant_scope", traceability: "semantic" })
    }
  }
  return { nodes, edges }
}

function routeToGraph(
  route: RouteInfo,
  skipListIndex: Map<string, SkipEntry[]>,
  constRegistry: Map<string, string>,
  methodRegistry: ReturnType<typeof buildMethodRegistry>,
  parsed: ParsedFile[],
  ownershipSources: ReadonlySet<string>,
  isolation: IsolationContext
): IntermediateExecutionGraph {
  const nodes: ExecutionNode[] = []
  const edges: ExecutionEdge[] = []

  const mwNodes = route.middleware
    .map((mw, i) => middlewareNode(mw, i, skipListIndex, route, constRegistry))
    .filter((n): n is ExecutionNode => !!n)

  nodes.push(...mwNodes)

  const validationNode = validationGateNode(route, methodRegistry, parsed)
  if (validationNode) nodes.push(validationNode)

  const handlerNode: ExecutionNode = {
    id:     "handler",
    type:   IR_NODE_TYPES.BUSINESS_HANDLER,
    symbol: route.handlerText,
    file:   route.file,
    line:   route.line,
    role:   "handler",
  }
  nodes.push(handlerNode)

  // Transaction boundary is a downstream effect of the handler running (it
  // lives inside the handler or the service it calls), so it's placed after
  // business_handler in the chain rather than before, like Laravel's graphs.
  const txnNode = transactionBoundaryNode(route, methodRegistry, parsed)
  if (txnNode) nodes.push(txnNode)

  // Ownership is resolved inside the handler, so like the transaction it
  // follows the handler node in the chain.
  const ownershipNode = ownershipCheckNode(route, methodRegistry, ownershipSources)
  if (ownershipNode) nodes.push(ownershipNode)

  const chain = [
    ...mwNodes,
    ...(validationNode ? [validationNode] : []),
    handlerNode,
    ...(ownershipNode ? [ownershipNode] : []),
    ...(txnNode ? [txnNode] : []),
  ]
  for (let i = 0; i < chain.length - 1; i++) {
    edges.push({
      from:         chain[i].id,
      to:           chain[i + 1].id,
      relation:     IR_EDGE_RELATIONS.PRECEDES,
      traceability: "static",
    })
  }

  // Queries hang off the handler (like Laravel's isolation nodes), outside the chain.
  const iso = isolationGraphPart(route, isolation)
  nodes.push(...iso.nodes)
  edges.push(...iso.edges)

  return {
    entrypoint:   `${route.method} ${route.path}`,
    method:       route.method,
    path:         route.path,
    nodes,
    edges,
    annotations:  [],
    framework:    "gin",
    ir_ver:       IR_VERSION,
    adapter_ver:  ADAPTER_VERSION,
  }
}

/**
 * Parses a Gin project's routing surface into one IntermediateExecutionGraph
 * per route: routes + auth gate (honoring global-middleware skip-lists),
 * authz-check role resolution, validation-gate from DTO binding tags, and
 * transaction-boundary detection (GORM `.Transaction()` closures, one hop
 * into a directly-called service method), and tenant isolation (GORM queries
 * with or without a tenant constraint, on routes that resolve a tenant).
 */
export function parseGinProject(files: GoSourceFile[], opts: ParseGinOptions = {}): IntermediateExecutionGraph[] {
  const routes = extractRoutes(files, opts)
  if (routes.length === 0) return []

  const parsed: ParsedFile[] = files.map((f) => ({ path: f.path, root: parseGo(f.content) }))

  const middlewareNames = new Set(routes.flatMap((r) => r.middleware.map((m) => m.shortName)))
  const skipListIndex   = buildSkipListIndex(parsed, middlewareNames)
  const constRegistry   = buildConstRegistry(files)
  const methodRegistry  = buildMethodRegistry(parsed)

  const ownershipSources = new Set(opts.ownershipSources ?? [])

  const signalMatch = tokenMatcher(opts.isolation?.tenantSignals ?? DEFAULT_TENANT_SIGNALS)
  const codeIndex = buildCodeIndex(parsed)
  // a GORM callback whose function mentions the tenant (sets TenantID on create, filters by it on query)
  const tenantHooks = new Set<"create" | "update" | "delete" | "query">()
  for (const [op, names] of codeIndex.callbacks) {
    if (names.some((n) => { const fn = codeIndex.functions.get(n); return !!fn && signalMatch(fn.text) })) {
      tenantHooks.add(op as "create" | "update" | "delete" | "query")
    }
  }

  const fieldTypeCache = new Map<string, Map<string, string>>()
  const isolation: IsolationContext = {
    methodRegistry,
    fieldTypesOf: (typeName) => {
      let fields = fieldTypeCache.get(typeName)
      if (!fields) {
        fields = new Map()
        for (const file of parsed) {
          const found = findStructFieldTypes(file.root, typeName)
          if (found) { fields = found; break }
        }
        fieldTypeCache.set(typeName, fields)
      }
      return fields
    },
    keyMatch:    tokenMatcher(opts.isolation?.tenantContextKeys ?? DEFAULT_TENANT_CONTEXT_KEYS),
    signalMatch,
    codeIndex,
    tenantHooks,
  }

  const resolved = routes.map((r) => withHandlerReceiver(r, parsed, isolation))
  return resolved.map((r) => routeToGraph(r, skipListIndex, constRegistry, methodRegistry, parsed, ownershipSources, isolation))
}

/**
 * Fills in a route's handler receiver type when route extraction could not:
 * a handler reached through a package-level variable (`api.Controllers.BoardApi.CreateBoard`)
 * or through a local of the registering function (`roles := controllers.NewSysRoleController()`
 * then `roles.List`). Resolved from the function that registers the route, so the
 * validation, transaction, ownership and isolation passes can read the handler.
 */
function withHandlerReceiver(route: RouteInfo, parsed: ParsedFile[], ctx: IsolationContext): RouteInfo {
  if (route.handlerReceiverType) return route
  const dot = route.handlerText.lastIndexOf(".")
  if (dot <= 0 || /[\s(){}]/.test(route.handlerText)) return route
  const receiver = route.handlerText.slice(0, dot)
  const methodName = route.handlerText.slice(dot + 1)
  const file = parsed.find((f) => f.path === route.file)
  const enclosing = file ? enclosingFunction(file.root, route.line) : null
  const site: HandlerMethod = enclosing
    ? { node: enclosing, file: route.file, line: enclosing.startPosition.row + 1 }
    : { node: file?.root ?? parsed[0].root, file: route.file, line: route.line }
  const type = resolveReceiverType(site, receiver, ctx.fieldTypesOf, ctx.codeIndex)
  const handler = type ? resolveMethod(ctx.methodRegistry, type, methodName) : null
  const receiverType = handler ? receiverTypeName(handler.node) : null
  return receiverType ? { ...route, handlerReceiverType: receiverType } : route
}

/** The innermost function or method declaration spanning a 1-based line. */
function enclosingFunction(root: SyntaxNode, line: number): SyntaxNode | null {
  let best: SyntaxNode | null = null
  for (const fn of findFunctionDecls(root)) {
    const start = fn.startPosition.row + 1
    const end = fn.endPosition.row + 1
    if (start <= line && line <= end && (!best || fn.startPosition.row >= best.startPosition.row)) best = fn
  }
  return best
}

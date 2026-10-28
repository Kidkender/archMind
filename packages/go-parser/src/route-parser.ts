import { parseGo, callParts, stringLiteralValue, functionName, functionParamNames, functionParamTypes, findFunctionDecls, statementsOf, walk } from "./ast.js"
import type { SyntaxNode } from "./ast.js"
import { shortMiddlewareName } from "./middleware-mapper.js"

export interface GoSourceFile {
  /** Relative path from project root — becomes ExecutionNode.file. */
  path: string
  content: string
}

export interface MiddlewareRef {
  /** Unqualified name, e.g. "AuthMiddleware" out of "middleware.AuthMiddleware". */
  shortName: string
  /** Raw call text as written, e.g. "middleware.RequireRole(model.RoleAdmin)". */
  text: string
  /** Raw argument texts, e.g. ["model.RoleAdmin", "model.RoleManager"]. */
  args: string[]
  file: string
  line: number
}

export interface RouteInfo {
  method: string
  /** Fully resolved path — concatenation of every enclosing Group() prefix. */
  path: string
  /** Raw text of the final (handler) argument, e.g. "handler.CreateOrder". */
  handlerText: string
  /** Bare struct type of the handler's receiver (e.g. "OrderHandler"), when resolvable — needed to look up the method body for validation-gate detection. */
  handlerReceiverType?: string
  /** Middleware in application order: inherited group middleware first, then inline. */
  middleware: MiddlewareRef[]
  file: string
  line: number
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])

interface GroupState {
  prefix: string
  middleware: MiddlewareRef[]
}

interface ParsedFile {
  path: string
  root: SyntaxNode
}

interface FunctionEntry {
  name: string
  node: SyntaxNode
  file: string
}

function toLine(node: SyntaxNode): number {
  return node.startPosition.row + 1
}

function isEngineConstructor(parts: { receiver: string | null; method: string }): boolean {
  return parts.receiver === "gin" && (parts.method === "Default" || parts.method === "New")
}

function toMiddlewareRef(node: SyntaxNode, file: string): MiddlewareRef | null {
  const parts = callParts(node)
  if (!parts) return null
  const qualified = parts.receiver ? `${parts.receiver}.${parts.method}` : parts.method
  return {
    shortName: shortMiddlewareName(qualified),
    text:      node.text,
    args:      parts.args.map((a) => a.text),
    file,
    line:      toLine(node),
  }
}

/**
 * Builds a global function registry (short name → declaration) spanning every
 * provided file. Route-registration functions are matched by name only,
 * ignoring package boundaries — the same approach Laravel's parser takes for
 * controller resolution across a project's namespace. Last declaration wins
 * on a name collision (acceptable for v1: same-named route registrars across
 * unrelated packages are not a pattern observed in any of the 3 surveyed repos)
 * — EXCEPT for the entry function itself (default "main"), which commonly
 * collides across `cmd/server/main.go`, `cmd/seed/main.go`,
 * `cmd/worker/main.go`, etc. in exactly this project layout. For that name,
 * prefer whichever declaration's body actually constructs a Gin engine
 * (`gin.Default()`/`gin.New()`) — the one real web-server entrypoint — over
 * an arbitrary last-wins pick that could silently resolve to a CLI script's
 * empty main() instead.
 */
function buildFunctionRegistry(files: ParsedFile[], entryName = "main"): Map<string, FunctionEntry> {
  const registry = new Map<string, FunctionEntry>()
  const sameDirectory = new Map<string, FunctionEntry>()
  for (const file of files) {
    for (const fn of findFunctionDecls(file.root)) {
      const name = functionName(fn)
      if (!name) continue
      sameDirectory.set(`${dirOf(file.path)}::${name}`, { name, node: fn, file: file.path })
      if (name === entryName && registry.has(entryName) && !looksLikeGinEntrypoint(fn)) continue
      registry.set(name, { name, node: fn, file: file.path })
    }
  }
  functionsByDirectory.set(registry, sameDirectory)
  functionSlices.set(registry, findFunctionSlices(files))
  return registry
}

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")))

// Side tables of one registry: its functions by directory, and the function slices (see findFunctionSlices).
const functionsByDirectory = new WeakMap<Map<string, FunctionEntry>, Map<string, FunctionEntry>>()
const functionSlices = new WeakMap<Map<string, FunctionEntry>, Map<string, string[]>>()

/** The function a call by this name means: the one in the caller's own directory when there is one (packages repeat names such as `Init`), else the project-wide one. */
function calleeFor(registry: Map<string, FunctionEntry>, name: string, fromFile: string): FunctionEntry | undefined {
  return functionsByDirectory.get(registry)?.get(`${dirOf(fromFile)}::${name}`) ?? registry.get(name)
}

/**
 * Functions appended to a package-level slice: `routers = append(routers, registerA, registerB)`, usually in
 * init(). Keyed by `<directory>::<slice name>`; the dispatcher that ranges over the slice sits in the same package.
 */
function findFunctionSlices(files: ParsedFile[]): Map<string, string[]> {
  const slices = new Map<string, string[]>()
  for (const file of files) {
    for (const n of walk(file.root)) {
      if (n.type !== "assignment_statement") continue
      const target = n.childForFieldName("left")?.namedChildren[0]
      const call = n.childForFieldName("right")?.namedChildren[0]
      if (target?.type !== "identifier" || call?.type !== "call_expression") continue
      const parts = callParts(call)
      if (!parts || parts.receiver !== null || parts.method !== "append" || parts.args[0]?.text !== target.text) continue
      const names = parts.args.slice(1).filter((a) => a.type === "identifier").map((a) => a.text)
      const key = `${dirOf(file.path)}::${target.text}`
      slices.set(key, [...(slices.get(key) ?? []), ...names])
    }
  }
  return slices
}

function looksLikeGinEntrypoint(fn: SyntaxNode): boolean {
  const body = fn.childForFieldName("body")
  if (!body) return false
  for (const node of statementsOf(body)) {
    const rhs = (node.childForFieldName("right") ?? node.namedChildren[1])?.namedChildren[0]
    if (rhs?.type === "call_expression") {
      const parts = callParts(rhs)
      if (parts && isEngineConstructor(parts)) return true
    }
  }
  return false
}

/**
 * The group an expression evaluates to: a tracked variable, `X.Group(path, mw...)`, or `X.Use(mw...)`, where X is
 * itself such an expression. Lets `r.Group("/api").Use(mw)` define a group in one statement and
 * `register(v1.Group("/users"))` pass one without naming it.
 */
function groupOf(expr: SyntaxNode, file: string, groups: Map<string, GroupState>): GroupState | undefined {
  if (expr.type === "identifier") return groups.get(expr.text)
  if (expr.type !== "call_expression") return undefined
  const fn = expr.childForFieldName("function")
  if (fn?.type !== "selector_expression") return undefined
  const operand = fn.childForFieldName("operand")
  const method = fn.childForFieldName("field")?.text
  if (!operand || (method !== "Group" && method !== "Use")) return undefined
  const base = groupOf(operand, file, groups)
  if (!base) return undefined

  const args = expr.childForFieldName("arguments")?.namedChildren ?? []
  const refs = (nodes: SyntaxNode[]): MiddlewareRef[] => nodes.map((a) => toMiddlewareRef(a, file)).filter((m): m is MiddlewareRef => !!m)
  if (method === "Use") return { ...base, middleware: [...base.middleware, ...refs(args)] }
  const [pathArg, ...mwArgs] = args
  return { prefix: base.prefix + (pathArg ? stringLiteralValue(pathArg) ?? "" : ""), middleware: [...base.middleware, ...refs(mwArgs)] }
}

/**
 * Walks one function body in source order, tracking which local variables
 * are gin route groups (the router param itself, `gin.Default()`/`gin.New()`
 * results, or `X.Group(...)` results) and their accumulated prefix +
 * middleware. Emits a RouteInfo for every `X.METHOD(path, ...)` call found on
 * a tracked group, and recurses into any call to another registry function
 * that receives a tracked group as an argument, OR that itself constructs
 * and returns a new engine (a "router factory" — `func NewRouter() *gin.Engine`
 * — a common alternative to the inject-the-engine-as-a-parameter style; both
 * patterns showed up across a 10-repo spot-check of real public Gin projects).
 *
 * Returns the GroupState of whatever this function returns via a bare
 * `return x` where `x` is itself a tracked group at that point, so a caller
 * assigning this function's result (`r := NewRouter()`) can bind its own
 * local to the right state. Returns undefined when nothing qualifies.
 */
function walkFunctionBody(
  fn: FunctionEntry,
  initialGroups: Map<string, GroupState>,
  registry: Map<string, FunctionEntry>,
  routes: RouteInfo[],
  visiting: Set<string>,
  walked: Set<string>
): GroupState | undefined {
  if (visiting.has(fn.name)) return undefined // guard against accidental recursion
  visiting.add(fn.name)
  walked.add(`${fn.file}:${fn.name}`)

  const body = fn.node.childForFieldName("body")
  if (!body) { visiting.delete(fn.name); return undefined }

  const groups = new Map(initialGroups)
  const paramTypes = functionParamTypes(fn.node)
  const statements = statementsOf(body)

  for (const stmt of statements) {
    handleStatement(stmt, fn.file, groups, paramTypes, registry, routes, visiting, walked)
  }

  visiting.delete(fn.name)
  return findReturnedGroupState(statements, groups)
}

/** Scans for a `return x` statement where `x` is a bare identifier that's a tracked group. */
function findReturnedGroupState(statements: SyntaxNode[], groups: Map<string, GroupState>): GroupState | undefined {
  for (const stmt of statements) {
    if (stmt.type !== "return_statement") continue
    const exprList = stmt.namedChildren[0]
    const expr = exprList?.type === "expression_list" ? exprList.namedChildren[0] : exprList
    if (expr?.type === "identifier" && groups.has(expr.text)) return groups.get(expr.text)
  }
  return undefined
}

function handleStatement(
  stmt: SyntaxNode,
  file: string,
  groups: Map<string, GroupState>,
  paramTypes: Map<string, string>,
  registry: Map<string, FunctionEntry>,
  routes: RouteInfo[],
  visiting: Set<string>,
  walked: Set<string>
): void {
  // Bare `{ ... }` scoping block — a common Go idiom for visually grouping a
  // route group's registrations (`apiv1 := r.Group(...); apiv1.Use(...); {
  // apiv1.GET(...) ... }`). Not a control-flow construct, just lexical
  // scoping — its statements execute unconditionally, in order, same as if
  // the braces weren't there, so recurse into it directly.
  if (stmt.type === "block") {
    for (const inner of statementsOf(stmt)) {
      handleStatement(inner, file, groups, paramTypes, registry, routes, visiting, walked)
    }
    return
  }

  // `local := expr` or `local = expr` — check if expr is a group-producing call
  if (stmt.type === "short_var_declaration" || stmt.type === "assignment_statement") {
    const left  = stmt.childForFieldName("left")  ?? stmt.namedChildren[0]
    const right = stmt.childForFieldName("right") ?? stmt.namedChildren[1]
    const targetName = left?.namedChildren[0]?.text
    const rhsExpr = right?.namedChildren[0]
    // `h := pkg.NewXxx(...)` / `h := &pkg.Xxx{}` — a handler built as a local
    // rather than received as a typed parameter. Recorded so its methods can
    // be resolved the same way as a parameter's.
    const builtType = targetName && rhsExpr ? constructedTypeName(rhsExpr) : undefined
    if (targetName && builtType) paramTypes.set(targetName, builtType)
    if (targetName && rhsExpr?.type === "call_expression") {
      const parts = callParts(rhsExpr)
      if (parts && isEngineConstructor(parts)) {
        groups.set(targetName, { prefix: "", middleware: [] })
      } else if (parts && (parts.method === "Group" || parts.method === "Use") && groupOf(rhsExpr, file, groups)) {
        groups.set(targetName, groupOf(rhsExpr, file, groups)!)
      } else if (parts) {
        // Router-factory pattern: `local := SomeRegisteredFn(...)` where the
        // callee builds (and returns) its own engine internally, rather than
        // receiving one as a parameter.
        const callee = calleeFor(registry, parts.method, file)
        if (callee) {
          const returned = walkFunctionBody(callee, resolveDelegationArgs(parts, callee, groups, file), registry, routes, visiting, walked)
          if (returned) groups.set(targetName, returned)
        }
      }
    }
    return
  }

  if (stmt.type === "for_statement") {
    walkRegistrarLoop(stmt, file, groups, registry, routes, visiting, walked)
    return
  }

  if (stmt.type !== "expression_statement") return
  const call = stmt.namedChildren[0]
  if (!call || call.type !== "call_expression") return
  const parts = callParts(call)
  if (!parts) return

  // X.Use(mw...) — extends X's middleware for everything registered after this line
  if (parts.method === "Use" && parts.receiver && groups.has(parts.receiver)) {
    const state = groups.get(parts.receiver)!
    const added = parts.args.map((a) => toMiddlewareRef(a, file)).filter((m): m is MiddlewareRef => !!m)
    groups.set(parts.receiver, { ...state, middleware: [...state.middleware, ...added] })
    return
  }

  // X.GET/POST/PUT/PATCH/DELETE(path, ...middleware, handler)
  if (parts.receiver && groups.has(parts.receiver) && HTTP_METHODS.has(parts.method)) {
    const state = groups.get(parts.receiver)!
    const [pathArg, ...rest] = parts.args
    if (!pathArg || rest.length === 0) return
    const suffix = stringLiteralValue(pathArg) ?? ""
    const handlerArg = rest[rest.length - 1]
    const inlineMwArgs = rest.slice(0, -1)
    const inlineMw = inlineMwArgs
      .map((a) => (a.type === "call_expression" ? toMiddlewareRef(a, file) : null))
      .filter((m): m is MiddlewareRef => !!m)

    routes.push({
      method:              parts.method,
      path:                state.prefix + suffix,
      handlerText:         handlerArg.text,
      handlerReceiverType: handlerReceiverType(handlerArg, paramTypes),
      middleware:          [...state.middleware, ...inlineMw],
      file,
      line:                toLine(call),
    })
    return
  }

  // Delegation to another registrar: fn(arg0, arg1, ...) where fn is a known
  // registry function and one or more args is a tracked group variable.
  // Matched by short name only, ignoring any package qualifier (parts.receiver) —
  // same "resolve by name across the whole project" approach the function
  // registry itself uses.
  const callee = calleeFor(registry, parts.method, file)
  if (callee) {
    const childInitial = resolveDelegationArgs(parts, callee, groups, file)
    if (childInitial.size > 0) {
      walkFunctionBody(callee, childInitial, registry, routes, visiting, walked)
    }
  }
}

/**
 * `for _, f := range routers { f(v1) }` over a slice of registrars: walks every function appended to that slice,
 * with the group the loop passes in.
 */
function walkRegistrarLoop(
  loop: SyntaxNode,
  file: string,
  groups: Map<string, GroupState>,
  registry: Map<string, FunctionEntry>,
  routes: RouteInfo[],
  visiting: Set<string>,
  walked: Set<string>
): void {
  const range = loop.namedChildren.find((c) => c.type === "range_clause")
  const body = loop.childForFieldName("body")
  const slice = range?.childForFieldName("right")
  const targets = range?.childForFieldName("left")?.namedChildren
  const loopVar = targets?.[targets.length - 1]?.text
  if (!body || slice?.type !== "identifier" || !loopVar) return

  const names = functionSlices.get(registry)?.get(`${dirOf(file)}::${slice.text}`) ?? []
  for (const inner of statementsOf(body)) {
    const call = inner.type === "expression_statement" ? inner.namedChildren[0] : undefined
    const parts = call?.type === "call_expression" ? callParts(call) : null
    if (!parts || parts.receiver !== null || parts.method !== loopVar) continue
    for (const name of names) {
      const callee = calleeFor(registry, name, file)
      const initial = callee ? resolveDelegationArgs(parts, callee, groups, file) : undefined
      if (callee && initial && initial.size > 0) walkFunctionBody(callee, initial, registry, routes, visiting, walked)
    }
  }
}

/** Maps a call's argument identifiers to the callee's matching parameter name, for every arg that's a currently-tracked group. */
function resolveDelegationArgs(
  parts: { args: SyntaxNode[] },
  callee: FunctionEntry,
  groups: Map<string, GroupState>,
  file: string
): Map<string, GroupState> {
  const paramNames = functionParamNames(callee.node)
  const childInitial = new Map<string, GroupState>()
  parts.args.forEach((argNode, i) => {
    const paramName = paramNames[i]
    const state = paramName ? groupOf(argNode, file, groups) : undefined
    if (paramName && state) childInitial.set(paramName, state)
  })
  return childInitial
}

/**
 * The bare type a constructor-style expression builds: `pkg.NewXxx(...)` →
 * "Xxx", `&pkg.Xxx{...}` or `Xxx{...}` → "Xxx". Anything else is undefined.
 */
function constructedTypeName(expr: SyntaxNode): string | undefined {
  if (expr.type === "call_expression") {
    const parts = callParts(expr)
    const match = parts?.method.match(/^New([A-Z]\w*)$/)
    return match?.[1]
  }
  const literal = expr.type === "unary_expression" ? expr.childForFieldName("operand") : expr
  if (literal?.type !== "composite_literal") return undefined
  const typeNode = literal.namedChildren.find((c) => c.type === "qualified_type" || c.type === "type_identifier")
  if (!typeNode) return undefined
  return typeNode.type === "qualified_type" ? typeNode.childForFieldName("name")?.text : typeNode.text
}

/**
 * For a handler expression `paramName.MethodName`, resolves paramName's
 * declared type from the enclosing function's own parameters — e.g. given
 * `func RegisterOrderRoutes(router gin.IRouter, handler *handler.OrderHandler)`
 * and the call `handler.CreateOrder`, returns "OrderHandler".
 * Returns undefined for anything else (bare function reference, unresolvable
 * receiver) — validation-gate detection is simply skipped for that route.
 */
function handlerReceiverType(handlerArg: SyntaxNode, paramTypes: Map<string, string>): string | undefined {
  if (handlerArg.type !== "selector_expression") return undefined
  const operand = handlerArg.childForFieldName("operand")
  if (!operand || operand.type !== "identifier") return undefined
  return paramTypes.get(operand.text)
}

export interface ExtractRoutesOptions {
  /**
   * Name of the one function to start walking from. When omitted, the walk starts from `main` and from every
   * function that builds a Gin engine, because a server often builds its engine several calls away from `main`.
   */
  entryFunction?: string
}

/** Names of the parameters typed `*gin.Engine`: the engine itself, so its prefix is known to be empty. */
function engineParams(fn: SyntaxNode): string[] {
  const names: string[] = []
  for (const p of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    let type = p.childForFieldName("type")
    if (type?.type === "pointer_type") type = type.namedChildren[0] ?? null
    if (type?.type !== "qualified_type") continue
    if (type.childForFieldName("package")?.text !== "gin" || type.childForFieldName("name")?.text !== "Engine") continue
    for (const id of p.namedChildren) if (id.type === "identifier") names.push(id.text)
  }
  return names
}

const routeKey = (r: RouteInfo): string => `${r.method} ${r.path} ${r.file}:${r.line}`

/**
 * Extracts every Gin route reachable from the entry function (default
 * `main`, plus every function that builds a Gin engine), resolving group
 * prefixes and middleware across function-call boundaries
 * (main → RegisterRoutes → RegisterXRoutes → r.GET(...)).
 *
 * `files` should include the whole set of Go source files that make up the
 * routing surface — typically `cmd/server/main.go`, `routes/routes.go`, and
 * everything under `routes/`. Files outside the reachable call graph from
 * the entry function are parsed (for the function registry) but otherwise
 * inert.
 */
export function extractRoutes(files: GoSourceFile[], opts: ExtractRoutesOptions = {}): RouteInfo[] {
  const parsed: ParsedFile[] = files.map((f) => ({ path: f.path, root: parseGo(f.content) }))
  const entryName = opts.entryFunction ?? "main"
  const registry = buildFunctionRegistry(parsed, entryName)

  const starts: FunctionEntry[] = []
  const entry = registry.get(entryName)
  if (entry) starts.push(entry)
  if (opts.entryFunction === undefined) {
    for (const file of parsed) {
      for (const fn of findFunctionDecls(file.root)) {
        const name = functionName(fn)
        if (name && fn !== entry?.node && looksLikeGinEntrypoint(fn)) starts.push({ name, node: fn, file: file.path })
      }
    }
  }

  const routes: RouteInfo[] = []
  const seen = new Set<string>()
  const walked = new Set<string>()
  const walk = (start: FunctionEntry, initial: Map<string, GroupState>): void => {
    const found: RouteInfo[] = []
    walkFunctionBody(start, initial, registry, found, new Set(), walked)
    for (const route of found) {
      if (seen.has(routeKey(route))) continue
      seen.add(routeKey(route))
      routes.push(route)
    }
  }
  for (const start of starts) walk(start, new Map())

  // A function that receives the engine and that nothing above reached is a starting point too (the engine is
  // built elsewhere, e.g. inside a command closure). Only the engine itself: a route group's prefix would be unknown.
  if (opts.entryFunction === undefined) {
    for (const file of parsed) {
      for (const fn of findFunctionDecls(file.root)) {
        const name = functionName(fn)
        const params = name ? engineParams(fn) : []
        if (!name || params.length === 0 || walked.has(`${file.path}:${name}`)) continue
        walk({ name, node: fn, file: file.path }, new Map(params.map((p) => [p, { prefix: "", middleware: [] }])))
      }
    }
  }
  return routes
}

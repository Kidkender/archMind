import { Node, SyntaxKind, type CallExpression, type ParameterDeclaration } from "ts-morph"
import { Evaluator, VERBS, isString, isFunctionNode, enclosingFunction, type Value, type RouterValue, type Env } from "./evaluator.js"
import { relativePath, type ExpressProject } from "./project.js"

/** A middleware or handler argument as written at a registration site. */
export interface ChainEntry {
  /** Source text, e.g. "auth('manageUsers')", "checkJwt", "userController.createUser". */
  text:   string
  /** Last identifier of the callee or reference, e.g. "auth", "checkJwt", "createUser". */
  name:   string
  /** Call arguments as written, e.g. ["'manageUsers'"]. */
  args:   string[]
  /** What the argument evaluates to (functions, externals, ...). */
  values: Value[]
  /**
   * For a call that stands for a function it wraps (`catchAsync(ctrl.list)`,
   * `ctrl.list.bind(ctrl)`): the wrapped argument's text, "<inline>" for a
   * function written in place. Undefined otherwise.
   */
  wrapped?: string
  node:   Node
  file:   string
  line:   number
}

export interface HandlerRef {
  /** "userController.createUser", or "<inline>" for a function written at the route. */
  symbol: string
  /** Where the handler function is defined, when it was resolved; else the route registration. */
  file:   string
  line:   number
  /** The handler function, when resolved. */
  node:   Node | null
}

export interface ExpressRoute {
  method:     string
  path:       string
  /** Where the route is registered. */
  file:       string
  line:       number
  /** Middleware in execution order: app/router `use` first, then the route's own. */
  middleware: ChainEntry[]
  handler:    HandlerRef
}

export interface ExtractResult {
  routes: ExpressRoute[]
  /** Registration sites on a known router whose path could not be resolved to a string. */
  unresolvedPaths: { file: string; line: number; text: string }[]
}

interface RouteRegistration {
  kind:    "route"
  router:  RouterValue
  method:  string
  paths:   string[]
  entries: ChainEntry[]
  site:    Node
}

interface UseRegistration {
  kind:     "use"
  router:   RouterValue
  prefixes: string[]
  /** In argument order: middleware entries and mounted routers. */
  items:    ({ kind: "middleware"; entry: ChainEntry } | { kind: "mount"; child: RouterValue })[]
  site:     Node
}

type Registration = RouteRegistration | UseRegistration

const MAX_MOUNT_DEPTH = 12

export function extractRoutes(ep: ExpressProject): ExtractResult {
  const ev = new Evaluator(ep)
  const registrations: Registration[] = []
  const unresolvedPaths: ExtractResult["unresolvedPaths"] = []

  for (const file of ep.files.values()) {
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression()
      if (!Node.isPropertyAccessExpression(callee)) continue
      const method = callee.getName()
      if (!VERBS.has(method) && method !== "use") continue
      for (const env of loopEnvs(call, ev)) {
        collect(call, method, callee.getExpression(), env, ev, registrations, unresolvedPaths)
      }
    }
  }

  return { routes: expand(registrations), unresolvedPaths }
}

/**
 * Environments to evaluate a registration under. A registration inside a
 * `forEach` / `map` callback over an array literal (`defaultRoutes.forEach(r =>
 * router.use(r.path, r.route))`) is evaluated once per element, so each path
 * stays paired with its own router.
 */
function loopEnvs(call: CallExpression, ev: Evaluator): Env[] {
  const fn = enclosingFunction(call)
  const parent = fn?.getParent()
  if (!fn || !parent || !Node.isCallExpression(parent) || !parent.getArguments().includes(fn)) return [new Map()]
  const callee = parent.getExpression()
  if (!Node.isPropertyAccessExpression(callee) || !["forEach", "map", "flatMap"].includes(callee.getName())) return [new Map()]
  const param = (fn as unknown as { getParameters(): ParameterDeclaration[] }).getParameters()[0]
  if (!param) return [new Map()]
  const envs: Env[] = []
  for (const arr of ev.evaluate(callee.getExpression())) {
    if (arr.kind !== "array" || !Node.isArrayLiteralExpression(arr.node)) continue
    for (const el of arr.node.getElements()) envs.push(new Map([[param, ev.evaluate(el)]]))
  }
  return envs.length > 0 ? envs : [new Map()]
}

function collect(
  call: CallExpression,
  method: string,
  receiver: Node,
  env: Env,
  ev: Evaluator,
  out: Registration[],
  unresolved: ExtractResult["unresolvedPaths"],
): void {
  const args = call.getArguments()
  for (const target of ev.evaluate(receiver, env)) {
    if (method === "use" && target.kind === "router") {
      const first = args[0]
      const firstStrings = first ? ev.evaluate(first, env).filter(isString).map((s) => s.value) : []
      const hasPrefix = firstStrings.length > 0
      const rest = hasPrefix ? args.slice(1) : args
      const items: UseRegistration["items"] = []
      for (const arg of flattenArgs(rest, ev, env)) {
        const values = ev.evaluate(arg, env)
        const routers = values.filter((v): v is RouterValue => v.kind === "router")
        if (routers.length > 0) {
          for (const child of routers) items.push({ kind: "mount", child })
        } else {
          items.push({ kind: "middleware", entry: chainEntry(arg, values, ev, env) })
        }
      }
      out.push({ kind: "use", router: target, prefixes: hasPrefix ? firstStrings : [""], items, site: call })
    } else if (VERBS.has(method) && target.kind === "router") {
      // app.get("env") reads a setting; a route needs a path and at least one handler
      if (args.length < 2) continue
      const paths = pathStrings(args[0], ev, env)
      if (paths.length === 0) {
        unresolved.push({ file: relativePath(call.getSourceFile()), line: call.getStartLineNumber(), text: args[0].getText() })
        continue
      }
      const entries = flattenArgs(args.slice(1), ev, env).map((a) => chainEntry(a, ev.evaluate(a, env), ev, env))
      out.push({ kind: "route", router: target, method: httpMethod(method), paths, entries, site: call })
    } else if (VERBS.has(method) && target.kind === "routeChain") {
      if (args.length < 1) continue
      const entries = flattenArgs(args, ev, env).map((a) => chainEntry(a, ev.evaluate(a, env), ev, env))
      out.push({ kind: "route", router: target.router, method: httpMethod(method), paths: target.paths, entries, site: call })
    }
  }
}

/** A route path argument: a string, or an array of strings (`router.get(["/a", "/b"], h)`). */
function pathStrings(arg: Node, ev: Evaluator, env: Env): string[] {
  const out: string[] = []
  for (const v of ev.evaluate(arg, env)) {
    if (v.kind === "string") out.push(v.value)
    else if (v.kind === "array" && Node.isArrayLiteralExpression(v.node)) {
      for (const el of v.node.getElements()) out.push(...ev.evaluate(el, env).filter(isString).map((s) => s.value))
    }
  }
  return out
}

/** Arguments with array literals (and constants holding one) spread out: `[checkJwt, checkRole(["ADMIN"])]`. */
function flattenArgs(args: Node[], ev: Evaluator, env: Env): Node[] {
  const out: Node[] = []
  for (const arg of args) {
    if (Node.isArrayLiteralExpression(arg)) {
      out.push(...flattenArgs(arg.getElements(), ev, env))
      continue
    }
    if (Node.isIdentifier(arg)) {
      const arrays = ev.evaluate(arg, env).filter((v) => v.kind === "array")
      const first = arrays[0]
      if (arrays.length === 1 && first.kind === "array" && Node.isArrayLiteralExpression(first.node)) {
        out.push(...flattenArgs(first.node.getElements(), ev, env))
        continue
      }
    }
    if (Node.isSpreadElement(arg)) {
      out.push(...flattenArgs([arg.getExpression()], ev, env))
      continue
    }
    out.push(arg)
  }
  return out
}

function chainEntry(node: Node, values: Value[], ev: Evaluator, env: Env): ChainEntry {
  let callee: Node = node
  let args: string[] = []
  if (Node.isCallExpression(node)) {
    callee = node.getExpression()
    args = node.getArguments().map((a) => a.getText())
    // a method chain is named after the call it starts from: body("email").isEmail() → "body"
    while (Node.isPropertyAccessExpression(callee) && Node.isCallExpression(callee.getExpression())) {
      const inner = callee.getExpression() as CallExpression
      callee = inner.getExpression()
      args = inner.getArguments().map((a) => a.getText())
    }
  }
  const name = Node.isPropertyAccessExpression(callee) ? callee.getName()
    : Node.isIdentifier(callee) ? callee.getText()
    : isFunctionNode(node) ? "<inline>"
    : callee.getText()
  return {
    text: node.getText().replace(/\s+/g, " "),
    name,
    wrapped: wrappedText(node, values, ev, env),
    args,
    values,
    node,
    file: relativePath(node.getSourceFile()),
    line: node.getStartLineNumber(),
  }
}

function httpMethod(verb: string): string {
  return verb === "all" ? "ALL" : verb.toUpperCase()
}

// ---------------------------------------------------------------------------
// Expansion: routers → full routes
// ---------------------------------------------------------------------------

interface ScopedMiddleware {
  entry: ChainEntry
  /** Full path prefix the middleware is mounted at ("" for all paths). */
  scope: string
}

function expand(registrations: Registration[]): ExpressRoute[] {
  const byRouter = new Map<string, Registration[]>()
  const mounted = new Set<string>()
  const routers = new Map<string, RouterValue>()
  for (const r of registrations) {
    routers.set(r.router.id, r.router)
    const list = byRouter.get(r.router.id) ?? []
    list.push(r)
    byRouter.set(r.router.id, list)
    if (r.kind === "use") {
      for (const item of r.items) {
        if (item.kind === "mount") {
          mounted.add(item.child.id)
          routers.set(item.child.id, item.child)
        }
      }
    }
  }
  for (const list of byRouter.values()) list.sort((a, b) => compareSites(a, b))

  const out: ExpressRoute[] = []
  const seen = new Set<string>()
  const visit = (router: RouterValue, prefix: string, inherited: ScopedMiddleware[], stack: Set<string>): void => {
    if (stack.has(router.id) || stack.size >= MAX_MOUNT_DEPTH) return
    const nextStack = new Set(stack).add(router.id)
    const local: ScopedMiddleware[] = []
    for (const reg of byRouter.get(router.id) ?? []) {
      if (reg.kind === "use") {
        for (const p of reg.prefixes) {
          const scope = joinPath(prefix, p)
          const pending: ScopedMiddleware[] = []
          for (const item of reg.items) {
            if (item.kind === "middleware") {
              pending.push({ entry: item.entry, scope: p === "" ? prefix : scope })
            } else {
              visit(item.child, scope, [...inherited, ...local, ...pending], nextStack)
            }
          }
          local.push(...pending)
        }
      } else {
        for (const p of reg.paths) {
          const full = joinPath(prefix, p)
          const key = `${reg.method} ${full} ${reg.site.getSourceFile().getFilePath()}:${reg.site.getStart()}`
          if (seen.has(key)) continue
          seen.add(key)
          const chain = [...inherited, ...local].filter((m) => inScope(m.scope, full)).map((m) => m.entry)
          const own = reg.entries.slice(0, -1)
          const last = reg.entries[reg.entries.length - 1]
          out.push({
            method:     reg.method,
            path:       full,
            file:       relativePath(reg.site.getSourceFile()),
            line:       reg.site.getStartLineNumber(),
            middleware: [...chain, ...own],
            handler:    handlerRef(last, reg.site),
          })
        }
      }
    }
  }

  // Apps first, then routers nothing mounts (mounted somewhere this parser cannot see)
  const roots = [...routers.values()].filter((r) => !mounted.has(r.id))
  roots.sort((a, b) => Number(b.isApp) - Number(a.isApp) || a.id.localeCompare(b.id))
  for (const root of roots) visit(root, "", [], new Set())
  return out
}

/**
 * Registration order on one router. Within a file, source order. A registration
 * in another file than the router was created in (a registrar function handed
 * the router) is ordered after the router's own file — the call site that hands
 * it over is not tracked, so middleware registered after that call is
 * over-applied to it.
 */
function compareSites(a: Registration, b: Registration): number {
  const home = a.router.file
  const fa = relativePath(a.site.getSourceFile())
  const fb = relativePath(b.site.getSourceFile())
  if (fa === fb) return a.site.getStart() - b.site.getStart()
  if (fa === home) return -1
  if (fb === home) return 1
  return fa.localeCompare(fb)
}

/** Express path-scoped middleware: `app.use("/api", mw)` runs for "/api" and "/api/...". */
function inScope(scope: string, path: string): boolean {
  if (scope === "" || scope === "/") return true
  return path === scope || path.startsWith(scope.endsWith("/") ? scope : `${scope}/`)
}

export function joinPath(prefix: string, path: string): string {
  if (!path || path === "/") return prefix || "/"
  const joined = `${prefix}/${path}`.replace(/\/{2,}/g, "/")
  const withSlash = joined.startsWith("/") ? joined : `/${joined}`
  return withSlash.length > 1 ? withSlash.replace(/\/$/, "") : withSlash
}

/**
 * The route handler: the last argument at the registration. A wrapper call
 * (`catchAsync(async (req, res) => ...)`, `asyncHandler(controller.list)`) is
 * looked through to the function it wraps.
 */
function handlerRef(entry: ChainEntry | undefined, site: Node): HandlerRef {
  const fallback = { file: relativePath(site.getSourceFile()), line: site.getStartLineNumber() }
  if (!entry) return { symbol: "<none>", node: null, ...fallback }
  const symbol = isFunctionNode(entry.node) ? "<inline>" : entry.wrapped ?? entry.text
  const fn = resolvedFunction(entry)
  if (!fn) return { symbol, node: null, ...fallback }
  return { symbol, node: fn, file: relativePath(fn.getSourceFile()), line: fn.getStartLineNumber() }
}

/** The handler function: written inline, or what the argument evaluates to (wrappers are looked through by the evaluator). */
function resolvedFunction(entry: ChainEntry): Node | null {
  if (isFunctionNode(entry.node)) return entry.node
  const fn = entry.values.find((v) => v.kind === "function")
  return fn && fn.kind === "function" ? fn.node : null
}

/**
 * When a call evaluated to a function that one of its arguments (or, for
 * `.bind`, its receiver) evaluates to, that argument's text: the call is a
 * wrapper and the argument is the real handler.
 */
function wrappedText(node: Node, values: Value[], ev: Evaluator, env: Env): string | undefined {
  if (!Node.isCallExpression(node)) return undefined
  const fns = new Set(values.filter((v) => v.kind === "function").map((v) => (v as { node: Node }).node))
  if (fns.size === 0) return undefined
  const callee = node.getExpression()
  if (Node.isPropertyAccessExpression(callee) && callee.getName() === "bind") return callee.getExpression().getText()
  for (const arg of node.getArguments()) {
    if (isFunctionNode(arg) && fns.has(arg)) return "<inline>"
    if (ev.evaluate(arg, env).some((v) => v.kind === "function" && fns.has(v.node))) return arg.getText().replace(/\s+/g, " ")
  }
  return undefined
}

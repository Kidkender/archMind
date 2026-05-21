import { readFileSync } from "fs"
import { dirname, join } from "path"
import { type SyntaxNode } from "tree-sitter"
import Parser from "tree-sitter"
// @ts-ignore
import PHP from "tree-sitter-php"
import type {
  IntermediateExecutionGraph,
  ExecutionNode,
  ExecutionEdge,
} from "@archmind/protocol"
import { middlewareToNode } from "./middleware-mapper.js"
import type { ConstantMap } from "./constant-resolver.js"

const _parser = new Parser()
_parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)

// ---- Public API -------------------------------------------------------

export interface ParseOptions {
  constants?: ConstantMap    // pre-resolved PHP class constants
  projectRoot?: string       // used for relative file paths in nodes
}

export function parseRouteFile(
  filePath: string,
  opts: ParseOptions = {}
): IntermediateExecutionGraph[] {
  const out: IntermediateExecutionGraph[] = []
  const ctx: RouteCtx = { middleware: [], prefix: "" }
  processFile(filePath, ctx, out, opts)
  return out
}

// ---- Internal ---------------------------------------------------------

interface RouteCtx {
  middleware: string[]   // inherited middleware strings
  prefix: string         // accumulated path prefix
}

interface MethodCall {
  name: string
  args: SyntaxNode[]
}

interface MethodChain {
  base: string           // class name, e.g. "Route"
  methods: MethodCall[]
}

function processFile(
  filePath: string,
  ctx: RouteCtx,
  out: IntermediateExecutionGraph[],
  opts: ParseOptions
): void {
  let source: string
  try {
    source = readFileSync(filePath, "utf-8")
  } catch {
    return
  }

  const tree = _parser.parse(source)
  walkProgram(tree.rootNode, ctx, out, filePath, opts)
}

function walkProgram(
  node: SyntaxNode,
  ctx: RouteCtx,
  out: IntermediateExecutionGraph[],
  file: string,
  opts: ParseOptions
): void {
  for (const child of node.children) {
    dispatchStatement(child, ctx, out, file, opts)
  }
}

function dispatchStatement(
  node: SyntaxNode,
  ctx: RouteCtx,
  out: IntermediateExecutionGraph[],
  file: string,
  opts: ParseOptions
): void {
  switch (node.type) {
    case "expression_statement": {
      const expr = node.firstNamedChild
      if (expr) handleExpression(expr, ctx, out, file, opts)
      break
    }
    case "require_expression":
    case "require_once_expression":
    case "include_expression":
    case "include_once_expression": {
      handleRequire(node, ctx, out, file, opts)
      break
    }
    default: {
      // compound_statement, namespace_definition, etc. — recurse
      for (const child of node.children) {
        dispatchStatement(child, ctx, out, file, opts)
      }
    }
  }
}

// ---- Route expression dispatch ----------------------------------------

function handleExpression(
  expr: SyntaxNode,
  ctx: RouteCtx,
  out: IntermediateExecutionGraph[],
  file: string,
  opts: ParseOptions
): void {
  const chain = extractMethodChain(expr)
  if (!chain || chain.base !== "Route") return

  const methods = chain.methods
  const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "options"])

  // Does the chain end in a group() call?
  const lastGroupIdx = findLastIndex(methods, (m) => m.name === "group")

  if (lastGroupIdx >= 0) {
    // Collect modifiers before the group call
    let newPrefix = ctx.prefix
    const newMiddleware = [...ctx.middleware]

    for (let i = 0; i < lastGroupIdx; i++) {
      const m = methods[i]
      if (m.name === "middleware") {
        newMiddleware.push(...resolveMiddlewareArgs(m.args, opts.constants))
      } else if (m.name === "prefix") {
        const seg = extractStringNode(m.args[0], opts.constants)
        if (seg) newPrefix = joinPath(newPrefix, seg)
      }
      // scopeBindings, name, etc. — ignored for now
    }

    const newCtx: RouteCtx = { middleware: newMiddleware, prefix: newPrefix }

    // Recurse into the anonymous function body
    const closureNode = methods[lastGroupIdx].args[0]
    if (closureNode) {
      const body = findFunctionBody(closureNode)
      if (body) walkProgram(body, newCtx, out, file, opts)
    }
    return
  }

  // Leaf route: Route::get/post/put/delete/patch('path', [Controller, 'method'])
  const routeVerb = methods.find((m) => HTTP_VERBS.has(m.name.toLowerCase()))
  if (!routeVerb) return

  // Additional inline middleware on this specific route
  const inlineMiddleware = methods
    .filter((m) => m.name === "middleware")
    .flatMap((m) => resolveMiddlewareArgs(m.args, opts.constants))

  const allMiddleware = [...ctx.middleware, ...inlineMiddleware]

  const rawPath = extractStringNode(routeVerb.args[0], opts.constants) ?? "/"
  const fullPath = joinPath(ctx.prefix, rawPath)
  const method = routeVerb.name.toUpperCase()

  const { controller, action } = extractControllerAction(routeVerb.args[1])

  const graph = buildGraph(method, fullPath, allMiddleware, controller, action)
  out.push(graph)
}

// ---- Graph construction -----------------------------------------------

function buildGraph(
  method: string,
  path: string,
  middlewareStack: string[],
  controller: string,
  action: string
): IntermediateExecutionGraph {
  const nodes: ExecutionNode[] = []
  const edges: ExecutionEdge[] = []

  // Middleware chain
  middlewareStack.forEach((raw, i) => {
    nodes.push(middlewareToNode(raw, i))
  })

  // Controller node
  const ctrlId = `ctrl_${controller.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${action}`
  nodes.push({
    id:     ctrlId,
    type:   "controller_action",
    symbol: `${controller}::${action}`,
    role:   "handler",
  })

  // Edges: middleware chain → controller
  const chainIds = nodes.map((n) => n.id)
  for (let i = 0; i < chainIds.length - 1; i++) {
    edges.push({
      from:         chainIds[i],
      to:           chainIds[i + 1],
      relation:     "next_middleware",
      traceability: "static",
    })
  }

  return {
    entrypoint:  `${method} ${path}`,
    method,
    path,
    nodes,
    edges,
    annotations: [],
  }
}

// ---- AST helpers ------------------------------------------------------

function extractMethodChain(node: SyntaxNode): MethodChain | null {
  const methods: MethodCall[] = []
  let current: SyntaxNode | null = node

  while (current) {
    if (
      current.type === "method_call_expression" ||
      current.type === "member_call_expression"
    ) {
      const nameNode = current.childForFieldName("name")
      const argsNode = current.childForFieldName("arguments")
      methods.unshift({
        name: nameNode?.text ?? "",
        args: argsNode ? getArgNodes(argsNode) : [],
      })
      current = current.childForFieldName("object") ?? null
    } else if (current.type === "static_method_call_expression") {
      const classNode =
        current.childForFieldName("class_name") ??
        current.childForFieldName("class")
      const nameNode = current.childForFieldName("name")
      const argsNode = current.childForFieldName("arguments")
      methods.unshift({
        name: nameNode?.text ?? "",
        args: argsNode ? getArgNodes(argsNode) : [],
      })
      return { base: classNode?.text ?? "", methods }
    } else {
      break
    }
  }

  return null
}

function getArgNodes(argsNode: SyntaxNode): SyntaxNode[] {
  return argsNode.children
    .filter((c) => c.type === "argument")
    .map((c) => c.firstNamedChild ?? c)
    .filter((c): c is SyntaxNode => c !== null)
}

function findFunctionBody(node: SyntaxNode): SyntaxNode | null {
  if (
    node.type === "anonymous_function_creation_expression" ||
    node.type === "anonymous_function_expression" ||
    node.type === "arrow_function"
  ) {
    return node.childForFieldName("body") ?? null
  }
  // Search children
  for (const child of node.children) {
    const found = findFunctionBody(child)
    if (found) return found
  }
  return null
}

// Resolve middleware from a Route::middleware(...) argument list
function resolveMiddlewareArgs(
  args: SyntaxNode[],
  constants?: ConstantMap
): string[] {
  const result: string[] = []
  for (const arg of args) {
    if (arg.type === "array_creation_expression") {
      // Route::middleware([...])
      for (const el of arg.children) {
        if (el.type === "array_element_initializer") {
          const val = el.firstNamedChild
          if (val) result.push(...resolveMiddlewareValue(val, constants))
        }
      }
    } else {
      result.push(...resolveMiddlewareValue(arg, constants))
    }
  }
  return result
}

function resolveMiddlewareValue(
  node: SyntaxNode,
  constants?: ConstantMap
): string[] {
  switch (node.type) {
    case "string":
    case "encapsed_string":
      return [unquote(node.text)]

    case "class_constant_access_expression": {
      // ResolveTenant::class  or  Permission::TASK_VIEW
      const parts = node.text.split("::")
      const className = parts[0].trim()
      const constName = parts[1]?.trim() ?? ""

      if (constName === "class") return [className]

      const resolved = constants?.[className]?.[constName]
      return [resolved ?? `${className}::${constName}`]
    }

    case "binary_expression": {
      // 'permission:'.Permission::TASK_VIEW
      const left = node.childForFieldName("left")
      const right = node.childForFieldName("right")
      const op = node.childForFieldName("operator")?.text ?? node.children.find(c => c.type === ".")?.text
      if (op !== ".") return [node.text]
      const ls = left ? resolveMiddlewareValue(left, constants) : [""]
      const rs = right ? resolveMiddlewareValue(right, constants) : [""]
      return ls.flatMap((l) => rs.map((r) => l + r))
    }

    default:
      return [node.text]
  }
}

function extractStringNode(
  node: SyntaxNode | undefined,
  constants?: ConstantMap
): string | null {
  if (!node) return null
  const parts = resolveMiddlewareValue(node, constants)
  return parts[0] ?? null
}

function extractControllerAction(node: SyntaxNode | undefined): {
  controller: string
  action: string
} {
  if (!node) return { controller: "UnknownController", action: "unknown" }

  // [TaskController::class, 'update']
  if (node.type === "array_creation_expression") {
    const elements = node.children.filter(
      (c) => c.type === "array_element_initializer"
    )
    const classEl = elements[0]?.firstNamedChild
    const actionEl = elements[1]?.firstNamedChild

    const controller = classEl
      ? resolveMiddlewareValue(classEl)[0] ?? "UnknownController"
      : "UnknownController"
    const action = actionEl ? unquote(actionEl.text) : "unknown"
    return { controller, action }
  }

  // Closure or invokable: treat as inline
  return { controller: "Closure", action: "invoke" }
}

// ---- require handling -------------------------------------------------

function handleRequire(
  node: SyntaxNode,
  ctx: RouteCtx,
  out: IntermediateExecutionGraph[],
  file: string,
  opts: ParseOptions
): void {
  // Find the path expression (first named child after the keyword)
  const pathExpr = node.firstNamedChild
  if (!pathExpr) return

  const resolved = resolveRequirePath(pathExpr, file)
  if (resolved) processFile(resolved, ctx, out, opts)
}

function resolveRequirePath(expr: SyntaxNode, fromFile: string): string | null {
  // require __DIR__.'/api/task.php'
  if (expr.type === "binary_expression") {
    const left = expr.childForFieldName("left")
    const right = expr.childForFieldName("right")
    const op = expr.childForFieldName("operator")?.text
    if (op !== ".") return null

    const base = left?.type === "magic_constant" && left.text === "__DIR__"
      ? dirname(fromFile)
      : null
    if (!base) return null

    const rel = right ? unquote(right.text) : null
    if (!rel) return null
    return join(base, rel)
  }

  // require '/absolute/path.php' — unlikely in Laravel
  if (expr.type === "string") {
    return unquote(expr.text)
  }

  return null
}

// ---- Utilities --------------------------------------------------------

function unquote(s: string): string {
  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  ) {
    return s.slice(1, -1)
  }
  return s
}

function joinPath(base: string, segment: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base
  const s = segment.startsWith("/") ? segment : "/" + segment
  return b + s
}

function findLastIndex<T>(arr: T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i
  }
  return -1
}

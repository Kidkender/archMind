import { readFileSync } from "fs"
import { dirname, join } from "path"
import Parser from "tree-sitter"
// @ts-ignore
import PHP from "tree-sitter-php"
import type {
  IntermediateExecutionGraph,
  ExecutionNode,
  ExecutionEdge,
} from "@archmind/protocol"
import { middlewareToNode, resolvedMiddlewareToNode } from "./middleware-mapper.js"
import type { ConstantMap } from "./constant-resolver.js"
import { extractUseMap } from "./controller-parser.js"
import type { AliasMap } from "./kernel-parser.js"

const _parser = new Parser()
_parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)

// ---- Public API -------------------------------------------------------

export interface ParseOptions {
  constants?: ConstantMap    // pre-resolved PHP class constants
  aliasMap?:  AliasMap       // Kernel.php alias → FQCN map for alias resolution
  projectRoot?: string
}

export function parseRouteFile(
  filePath: string,
  opts: ParseOptions = {}
): IntermediateExecutionGraph[] {
  const out: IntermediateExecutionGraph[] = []
  processFile(filePath, { middleware: [], prefix: "" }, out, opts)
  return out
}

// ---- Internal ---------------------------------------------------------

interface RouteCtx {
  middleware: string[]
  prefix:     string
}

interface MethodCall {
  name: string
  args: Parser.SyntaxNode[]
}

interface MethodChain {
  base:    string
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
  const tree   = _parser.parse(source)
  const useMap = extractUseMap(tree.rootNode)
  walkBlock(tree.rootNode, ctx, out, filePath, opts, useMap)
}

// Walk any block-like node (program or compound_statement)
function walkBlock(
  node: Parser.SyntaxNode,
  ctx: RouteCtx,
  out: IntermediateExecutionGraph[],
  file: string,
  opts: ParseOptions,
  useMap: Map<string, string>
): void {
  for (const child of node.children) {
    dispatchNode(child, ctx, out, file, opts, useMap)
  }
}

function dispatchNode(
  node: Parser.SyntaxNode,
  ctx: RouteCtx,
  out: IntermediateExecutionGraph[],
  file: string,
  opts: ParseOptions,
  useMap: Map<string, string>
): void {
  if (node.type === "expression_statement") {
    const expr = node.firstNamedChild
    if (!expr) return

    if (isRequireNode(expr)) {
      handleRequire(expr, ctx, out, file, opts, useMap)
    } else {
      handleRouteExpression(expr, ctx, out, file, opts, useMap)
    }
    return
  }

  // Recurse into other containers (compound_statement, namespace blocks, etc.)
  for (const child of node.children) {
    dispatchNode(child, ctx, out, file, opts, useMap)
  }
}

function isRequireNode(node: Parser.SyntaxNode): boolean {
  return (
    node.type === "require_expression" ||
    node.type === "require_once_expression" ||
    node.type === "include_expression" ||
    node.type === "include_once_expression"
  )
}

// ---- Route expression handler -----------------------------------------

function handleRouteExpression(
  expr: Parser.SyntaxNode,
  ctx: RouteCtx,
  out: IntermediateExecutionGraph[],
  file: string,
  opts: ParseOptions,
  useMap: Map<string, string>
): void {
  const chain = extractMethodChain(expr)
  if (!chain || chain.base !== "Route") return

  const { methods } = chain
  const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "options"])

  // Group call — descend with enriched context
  const groupIdx = findLastIndex(methods, (m) => m.name === "group")

  if (groupIdx >= 0) {
    let newPrefix = ctx.prefix
    const newMiddleware = [...ctx.middleware]

    for (let i = 0; i < groupIdx; i++) {
      const m = methods[i]
      if (m.name === "middleware") {
        newMiddleware.push(...resolveMiddlewareArgs(m.args, opts.constants))
      } else if (m.name === "prefix") {
        const seg = resolveString(m.args[0], opts.constants)
        if (seg) newPrefix = joinPath(newPrefix, seg)
      }
      // name(), scopeBindings(), where() — ignored
    }

    const closureNode = methods[groupIdx].args[0]
    if (closureNode) {
      const body = getFunctionBody(closureNode)
      if (body) {
        walkBlock(body, { middleware: newMiddleware, prefix: newPrefix }, out, file, opts, useMap)
      }
    }
    return
  }

  // Leaf route: Route::get/post/put/delete/patch(...)
  const routeVerb = methods.find((m) => HTTP_VERBS.has(m.name.toLowerCase()))
  if (!routeVerb) return

  const inlineMiddleware = methods
    .filter((m) => m.name === "middleware")
    .flatMap((m) => resolveMiddlewareArgs(m.args, opts.constants))

  const rawPath = resolveString(routeVerb.args[0], opts.constants) ?? "/"
  const fullPath = joinPath(ctx.prefix, rawPath)
  const method = routeVerb.name.toUpperCase()
  const { controller, action } = extractControllerAction(routeVerb.args[1])

  out.push(buildGraph(method, fullPath, [...ctx.middleware, ...inlineMiddleware], controller, action, useMap, opts))
}

// ---- Graph construction -----------------------------------------------

function buildGraph(
  method: string,
  path: string,
  middlewareStack: string[],
  controller: string,
  action: string,
  useMap: Map<string, string>,
  opts: ParseOptions = {}
): IntermediateExecutionGraph {
  const nodes: ExecutionNode[] = []
  const edges: ExecutionEdge[] = []

  middlewareStack.forEach((raw, i) => {
    const resolved = opts.aliasMap ? resolveAlias(raw, opts.aliasMap) : null
    if (resolved) {
      nodes.push(resolvedMiddlewareToNode(raw, resolved.fqcn, resolved.args, i))
    } else {
      nodes.push(middlewareToNode(raw, i))
    }
  })

  // Resolve controller short name → FQCN → relative file path
  const fqcn = useMap.get(controller) ?? controller
  const file = fqcn.includes("\\")
    ? fqcn.replace(/^App\\/, "app/").replace(/\\/g, "/") + ".php"
    : undefined

  const ctrlId = `ctrl_${controller.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${action}`
  const ctrlNode: ExecutionNode = {
    id:     ctrlId,
    type:   "controller_action",
    symbol: `${controller}::${action}`,
    role:   "handler",
    ...(file ? { file } : {}),
  }
  nodes.push(ctrlNode)

  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ from: nodes[i].id, to: nodes[i + 1].id, relation: "next_middleware", traceability: "static" })
  }

  return { entrypoint: `${method} ${path}`, method, path, nodes, edges, annotations: [] }
}

// ---- AST helpers ------------------------------------------------------

// Unwind a chained method call into a flat list:
// Route::prefix('x')->name('y')->group(fn) → { base:'Route', methods:[prefix,name,group] }
function extractMethodChain(node: Parser.SyntaxNode): MethodChain | null {
  const methods: MethodCall[] = []
  let cur: Parser.SyntaxNode | null = node

  while (cur) {
    if (cur.type === "member_call_expression") {
      const nameNode = cur.childForFieldName("name")
      const argsNode = cur.childForFieldName("arguments")
      methods.unshift({
        name: nameNode?.text ?? "",
        args: argsNode ? getArgNodes(argsNode) : [],
      })
      cur = cur.childForFieldName("object") ?? null
    } else if (cur.type === "scoped_call_expression") {
      // Route::method(...)
      const scopeNode = cur.childForFieldName("scope")
      const nameNode  = cur.childForFieldName("name")
      const argsNode  = cur.childForFieldName("arguments")
      methods.unshift({
        name: nameNode?.text ?? "",
        args: argsNode ? getArgNodes(argsNode) : [],
      })
      return { base: scopeNode?.text ?? "", methods }
    } else {
      break
    }
  }

  return null
}

function getArgNodes(argsNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
  return argsNode.children
    .filter((c) => c.type === "argument")
    .map((c) => c.firstNamedChild)
    .filter((c): c is Parser.SyntaxNode => c !== null)
}

function getFunctionBody(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  // anonymous_function has field 'body' → compound_statement
  if (node.type === "anonymous_function") {
    return node.childForFieldName("body") ?? null
  }
  // Search first child that is a compound_statement
  for (const child of node.children) {
    if (child.type === "compound_statement") return child
    const found = getFunctionBody(child)
    if (found) return found
  }
  return null
}

// Resolve a middleware argument list into string values
function resolveMiddlewareArgs(args: Parser.SyntaxNode[], constants?: ConstantMap): string[] {
  const result: string[] = []
  for (const arg of args) {
    if (arg.type === "array_creation_expression") {
      for (const el of arg.children) {
        if (el.type === "array_element_initializer") {
          const val = el.firstNamedChild
          if (val) result.push(...resolveValue(val, constants))
        }
      }
    } else {
      result.push(...resolveValue(arg, constants))
    }
  }
  return result
}

function resolveValue(node: Parser.SyntaxNode, constants?: ConstantMap): string[] {
  switch (node.type) {
    case "string":
    case "encapsed_string": {
      // 'foo' or "foo"
      const content = node.children.find((c) => c.type === "string_content")
      return [content?.text ?? unquote(node.text)]
    }

    case "class_constant_access_expression": {
      // TaskController::class  or  Permission::TASK_VIEW
      const className = node.children[0]?.text ?? ""
      const constName = node.children[2]?.text ?? ""
      if (constName === "class") return [className]
      const resolved = constants?.[className]?.[constName]
      return [resolved ?? `${className}::${constName}`]
    }

    case "binary_expression": {
      // 'permission:'.Permission::TASK_VIEW
      const op = node.childForFieldName("operator")?.text
      if (op !== ".") return [node.text]
      const left  = node.childForFieldName("left")
      const right = node.childForFieldName("right")
      const ls = left  ? resolveValue(left,  constants) : [""]
      const rs = right ? resolveValue(right, constants) : [""]
      return ls.flatMap((l) => rs.map((r) => l + r))
    }

    default:
      return [node.text]
  }
}

function resolveString(node: Parser.SyntaxNode | undefined, constants?: ConstantMap): string | null {
  if (!node) return null
  return resolveValue(node, constants)[0] ?? null
}

function extractControllerAction(node: Parser.SyntaxNode | undefined): {
  controller: string
  action:     string
} {
  if (!node) return { controller: "UnknownController", action: "unknown" }

  if (node.type === "array_creation_expression") {
    const elements = node.children.filter((c) => c.type === "array_element_initializer")
    const classEl  = elements[0]?.firstNamedChild
    const actionEl = elements[1]?.firstNamedChild
    const controller = classEl  ? resolveValue(classEl)[0]  ?? "UnknownController" : "UnknownController"
    const action     = actionEl ? resolveValue(actionEl)[0] ?? "unknown"           : "unknown"
    return { controller, action }
  }

  return { controller: "Closure", action: "invoke" }
}

// ---- require handling -------------------------------------------------

function handleRequire(
  node: Parser.SyntaxNode,
  ctx: RouteCtx,
  out: IntermediateExecutionGraph[],
  file: string,
  opts: ParseOptions,
  _useMap: Map<string, string>  // not threaded into sub-files — each file builds its own
): void {
  // require_expression: [require] [expr]
  // The path is the first non-keyword named child
  const pathExpr = (node.children as Parser.SyntaxNode[]).find(
    (c) => c.type !== "require" && c.type !== "require_once" &&
           c.type !== "include" && c.type !== "include_once" &&
           !c.type.startsWith("(")
  )
  if (!pathExpr) return

  const resolved = resolveRequirePath(pathExpr, file)
  if (resolved) processFile(resolved, ctx, out, opts)
}

function resolveRequirePath(expr: Parser.SyntaxNode, fromFile: string): string | null {
  // __DIR__ . '/api/task.php'
  if (expr.type === "binary_expression") {
    const op    = expr.childForFieldName("operator")?.text
    const left  = expr.childForFieldName("left")
    const right = expr.childForFieldName("right")
    if (op !== ".") return null
    if (left?.text !== "__DIR__") return null
    const rel = right ? resolveValue(right)[0] ?? null : null
    if (!rel) return null
    return join(dirname(fromFile), rel)
  }

  if (expr.type === "string") {
    const content = expr.children.find((c) => c.type === "string_content")
    return content?.text ?? unquote(expr.text)
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

// ---- Alias resolution -------------------------------------------------

// Built-in middleware patterns already handled by middlewareToNode — skip these.
const BUILTIN_PREFIXES = /^(auth|permission|throttle):/
const BUILTIN_NAMES    = new Set(["signed", "verified"])

/**
 * Resolve a raw middleware string against the kernel alias map.
 * Returns null if the string should be handled by middlewareToNode directly.
 */
function resolveAlias(
  raw: string,
  aliasMap: AliasMap
): { fqcn: string; args: string[] } | null {
  if (BUILTIN_PREFIXES.test(raw) || BUILTIN_NAMES.has(raw)) return null

  const colonIdx = raw.indexOf(":")
  const key    = colonIdx >= 0 ? raw.slice(0, colonIdx) : raw
  const argStr = colonIdx >= 0 ? raw.slice(colonIdx + 1) : ""

  const fqcn = aliasMap[key]
  if (!fqcn) return null

  return { fqcn, args: argStr ? argStr.split(",") : [] }
}

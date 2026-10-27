import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { bareTypeName, walk, type SyntaxNode } from "@kidkender/archmind-go-parser"
import { collectFacts, type Decl, type GoFile } from "./parse.js"

/** The type a handler variable has inside the function that registers its routes, or null when it cannot be told. */
function variableType(decl: Decl, variable: string, constructors: Map<string, string>): string | null {
  const param = decl.params.get(variable)
  if (param) return param
  const body = decl.node.childForFieldName("body")
  if (!body) return null
  for (const n of walk(body)) {
    if (n.type !== "short_var_declaration" && n.type !== "assignment_statement") continue
    const left = n.childForFieldName("left")?.namedChildren[0]
    const right = n.childForFieldName("right")?.namedChildren[0]
    if (left?.text !== variable || !right) continue
    return builtType(right, constructors)
  }
  return null
}

/** The type of `&pkg.T{}`, `pkg.T{}` or `pkg.NewT(...)` (the constructor's first result). */
function builtType(expr: SyntaxNode, constructors: Map<string, string>): string | null {
  const value = expr.type === "unary_expression" ? expr.childForFieldName("operand") : expr
  if (!value) return null
  if (value.type === "composite_literal") {
    const type = value.childForFieldName("type")
    return type ? bareTypeName(type) : null
  }
  if (value.type !== "call_expression") return null
  const fn = value.childForFieldName("function")
  const name = fn?.type === "selector_expression" ? fn.childForFieldName("field")?.text : fn?.text
  return (name && constructors.get(name)) ?? null
}

/**
 * Handler key to routes, built from archMind's route graphs. The graph names a handler by the
 * variable it is registered through ("h.Cancel"), which says nothing about its type. With the Go
 * sources the variable is resolved to its type from the registering function (a parameter, a
 * constructor call or a composite literal) and the key is "Type.Method", lower-cased. Without
 * sources, or when the variable cannot be resolved, the key is the registered symbol lower-cased,
 * which matches only when the variable is named after its type ("mailHandler.Get").
 */
export function handlerRouteIndex(graphs: IntermediateExecutionGraph[], files: GoFile[] = []): Map<string, string[]> {
  const decls = files.length > 0 ? collectFacts(files).facts.flatMap((f) => f.decls) : []
  const constructors = new Map<string, string>()
  for (const d of decls) if (!d.recv && d.returns) constructors.set(d.name, d.returns)

  const index = new Map<string, string[]>()
  for (const g of graphs) {
    const handler = g.nodes.find((n) => n.type === "ir:business_handler")
    if (!handler) continue
    const key = (resolveKey(handler, decls, constructors) ?? handler.symbol).toLowerCase()
    const routes = index.get(key) ?? []
    routes.push(g.entrypoint)
    index.set(key, routes)
  }
  return index
}

function resolveKey(
  handler: { symbol: string; file?: string; line?: number },
  decls: Decl[],
  constructors: Map<string, string>,
): string | null {
  const dot = handler.symbol.indexOf(".")
  if (dot < 0 || !handler.file || !handler.line) return null
  const line = handler.line
  const enclosing = decls.find(
    (d) => d.file === handler.file && d.node.startPosition.row + 1 <= line && line <= d.node.endPosition.row + 1,
  )
  if (!enclosing) return null
  const type = variableType(enclosing, handler.symbol.slice(0, dot), constructors)
  return type ? `${type}.${handler.symbol.slice(dot + 1)}` : null
}

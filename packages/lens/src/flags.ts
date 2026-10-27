import { walk, type SyntaxNode } from "@kidkender/archmind-go-parser"
import type { Decl } from "./parse.js"

export interface BodyFlags {
  /** The body calls `.Transaction(...)`. */
  opensTransaction: boolean
  /** The body assigns to a field or element, increments one, or calls delete(). */
  mutatesState: boolean
  /** The body calls something named rollback, undo, revert or compensate. */
  compensates: boolean
  /** A parameter is a database handle (`*gorm.DB`), so the method works with the caller's transaction. */
  takesTx: boolean
  /** A parameter is a web framework's request context (`*gin.Context`), so the function is an HTTP handler. */
  takesRequest: boolean
  /** Number of parameters; null when the function is variadic. */
  arity: number | null
}

const COMPENSATION = /^(rollback|undo|revert|compensate)/i
const DB_TYPES = new Set(["DB", "Tx"])

/** The variable a field or element expression starts from: `h.rooms[z].x` gives "h". */
function rootIdentifier(n: SyntaxNode | undefined): string | null {
  let cur: SyntaxNode | null | undefined = n
  while (cur && ["selector_expression", "index_expression", "parenthesized_expression", "unary_expression", "star_expression", "call_expression"].includes(cur.type)) {
    // a call is followed through the thing it is called on: f.stateOf(k) starts from f
    cur = cur.type === "call_expression" ? cur.childForFieldName("function") : (cur.childForFieldName("operand") ?? cur.childForFieldName("x") ?? cur.namedChildren[0])
  }
  return cur?.type === "identifier" ? cur.text : null
}

const isFieldOrElement = (n: SyntaxNode | undefined): boolean => n?.type === "selector_expression" || n?.type === "index_expression"

function mentions(expr: SyntaxNode | null, names: Set<string>): boolean {
  if (!expr) return false
  for (const n of walk(expr)) if (n.type === "identifier" && names.has(n.text)) return true
  return false
}

function calleeName(call: SyntaxNode): string | null {
  const fn = call.childForFieldName("function")
  if (fn?.type === "identifier") return fn.text
  return fn?.type === "selector_expression" ? (fn.childForFieldName("field")?.text ?? null) : null
}

/** A parameter typed `pkg.Context` for a package other than the standard `context`. */
function takesRequestContext(decl: Decl): boolean {
  const params = decl.node.childForFieldName("parameters")
  for (const p of params?.namedChildren ?? []) {
    let type = p.childForFieldName("type")
    while (type?.type === "pointer_type") type = type.namedChildren[0] ?? null
    if (type?.type !== "qualified_type") continue
    if (type.childForFieldName("name")?.text === "Context" && type.childForFieldName("package")?.text !== "context") return true
  }
  return false
}

/** How many arguments a call must pass: one per declared parameter, null when the last is variadic. */
function arityOf(decl: Decl): number | null {
  let count = 0
  for (const p of decl.node.childForFieldName("parameters")?.namedChildren ?? []) {
    if (p.type === "variadic_parameter_declaration") return null
    if (p.type === "parameter_declaration") count += Math.max(1, p.namedChildren.filter((c) => c.type === "identifier").length)
  }
  return count
}

export function bodyFlags(decl: Decl): BodyFlags {
  const flags: BodyFlags = {
    opensTransaction: false,
    mutatesState: false,
    compensates: false,
    takesTx: [...decl.params.values()].some((t) => DB_TYPES.has(t)),
    takesRequest: takesRequestContext(decl),
    arity: arityOf(decl),
  }
  // Variables that point into the receiver's own state: the receiver itself and anything taken from it.
  const owned = new Set<string>(decl.recvVar ? [decl.recvVar] : [])
  const touchesOwned = (n: SyntaxNode | undefined): boolean => isFieldOrElement(n) && owned.has(rootIdentifier(n) ?? "")
  for (const n of walk(decl.node)) {
    if (n.type === "short_var_declaration") {
      const first = n.childForFieldName("left")?.namedChildren[0]
      if (first?.type === "identifier" && mentions(n.childForFieldName("right"), owned)) owned.add(first.text)
    } else if (n.type === "call_expression") {
      const name = calleeName(n)
      if (name === "Transaction") flags.opensTransaction = true
      if (name === "delete" && owned.has(rootIdentifier(n.childForFieldName("arguments")?.namedChildren[0]) ?? "")) flags.mutatesState = true
      if (name && COMPENSATION.test(name)) flags.compensates = true
    } else if (n.type === "assignment_statement") {
      if ((n.childForFieldName("left")?.namedChildren ?? []).some(touchesOwned)) flags.mutatesState = true
    } else if (n.type === "inc_dec_statement") {
      if (touchesOwned(n.namedChildren[0])) flags.mutatesState = true
    }
  }
  return flags
}

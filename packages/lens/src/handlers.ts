import { walk, type SyntaxNode } from "@kidkender/archmind-go-parser"
import { collectFacts, type GoFile } from "./parse.js"

export interface UnscopedHandler {
  kind: "unscoped_handler_read"
  /** `Type.Method` or `Func`: reads a record by a path id and serves it without relating it to the caller. */
  function: string
  file: string
  line: number
  /** The variable holding the record that is served. */
  served: string
}

const SOURCE_FUNC = /^ParseParam/
const SERVE_METHODS = new Set(["JSON", "IndentedJSON", "XML", "YAML", "String", "Data"])
const SCOPE_NAME = /scope|authoriz|permit|allow|owns|ownership|forbid/i

const isTest = (path: string): boolean => path.endsWith("_test.go")

function identifiers(node: SyntaxNode): string[] {
  const out: string[] = []
  for (const n of walk(node)) if (n.type === "identifier") out.push(n.text)
  return out
}

/** The callee of a call: its name, and the text of what it is selected from (`h.svc` for `h.svc.Get(...)`), if any. */
function callee(call: SyntaxNode): { name: string; operand: SyntaxNode | null } | null {
  const fn = call.childForFieldName("function")
  if (!fn) return null
  if (fn.type === "identifier") return { name: fn.text, operand: null }
  if (fn.type !== "selector_expression") return null
  const field = fn.childForFieldName("field")
  return field ? { name: field.text, operand: fn.childForFieldName("operand") } : null
}

const mentions = (node: SyntaxNode, names: Set<string>): boolean => identifiers(node).some((id) => names.has(id))

/** A parameter whose bare type is `Context` (the request context of a web framework). */
function contextParam(params: Map<string, string>): string | null {
  for (const [name, type] of params) if (type === "Context") return name
  return null
}

/**
 * Handlers that take a record id from the request path, load the record and send it back, with no call named
 * like a scope check on the record and no comparison between the record and something read from the request
 * context. A candidate for an IDOR (reading another tenant's record by guessing ids). It is a heuristic about
 * syntax: a check done in the service or in a middleware is not seen, and a handler that only changes state
 * without sending the record back is not examined.
 */
export function findUnscopedHandlers(files: GoFile[]): UnscopedHandler[] {
  const out: UnscopedHandler[] = []
  for (const facts of collectFacts(files.filter((f) => !isTest(f.path))).facts) {
    for (const d of facts.decls) {
      const ctx = contextParam(d.params)
      const body = d.node.childForFieldName("body")
      if (!ctx || !body) continue
      const path = new Set<string>()
      const loaded = new Set<string>()
      let served: string | null = null
      let evidence = false
      let sawSource = false

      const isSource = (n: SyntaxNode): boolean => {
        for (const c of walk(n)) {
          if (c.type !== "call_expression") continue
          const callee_ = callee(c)
          if (!callee_) continue
          const args = c.childForFieldName("arguments")
          if (SOURCE_FUNC.test(callee_.name) && args && identifiers(args).includes(ctx)) return true
          if (callee_.name === "Param" && callee_.operand?.text === ctx) return true
        }
        return false
      }
      const isLoad = (n: SyntaxNode): boolean => {
        for (const c of walk(n)) {
          if (c.type !== "call_expression") continue
          const callee_ = callee(c)
          const args = c.childForFieldName("arguments")
          if (!callee_?.operand || !args || !mentions(args, path)) continue
          if (callee_.operand.type === "identifier" && facts.imports.has(callee_.operand.text)) continue
          return true
        }
        return false
      }

      for (const n of walk(body)) {
        if ((n.type === "short_var_declaration" || n.type === "assignment_statement") && n.childForFieldName("right")) {
          const left = n.childForFieldName("left")
          const right = n.childForFieldName("right")!
          const names = left ? identifiers(left) : []
          const source = isSource(right)
          const load = !source && isLoad(right)
          const pathy = source || (!load && mentions(right, path))
          const loady = !source && (load || mentions(right, loaded))
          names.forEach((name, i) => {
            path.delete(name)
            loaded.delete(name)
            if (pathy) path.add(name)
            if (loady && (!load || i === 0)) loaded.add(name)
          })
          if (source) sawSource = true
        }
        if (n.type === "binary_expression") {
          const op = n.childForFieldName("operator")?.text
          const l = n.childForFieldName("left")
          const r = n.childForFieldName("right")
          if ((op === "==" || op === "!=") && l && r && l.type !== "nil" && r.type !== "nil") {
            const fromCtx = (s: SyntaxNode): boolean =>
              [...walk(s)].some((c) => c.type === "call_expression" && identifiers(c.childForFieldName("arguments") ?? c).includes(ctx))
            if ((mentions(l, loaded) && fromCtx(r)) || (mentions(r, loaded) && fromCtx(l))) evidence = true
          }
        }
        if (n.type !== "call_expression") continue
        const c = callee(n)
        const args = n.childForFieldName("arguments")
        if (!c || !args) continue
        if (SCOPE_NAME.test(c.name) && mentions(args, loaded)) evidence = true
        if (SERVE_METHODS.has(c.name) && c.operand?.text === ctx && served === null) {
          const hit = identifiers(args).find((id) => loaded.has(id))
          if (hit) served = hit
        }
      }
      if (sawSource && served !== null && !evidence) {
        out.push({ kind: "unscoped_handler_read", function: d.recv ? `${d.recv}.${d.name}` : d.name, file: d.file, line: d.node.startPosition.row + 1, served })
      }
    }
  }
  return out
}

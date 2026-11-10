import { walk, callParts, findCalls, functionParamTypes, type SyntaxNode } from "./ast.js"
import type { HandlerMethod } from "./handler-parser.js"

/**
 * Tenant isolation for Gin + GORM, the Go counterpart of laravel-parser's
 * isolation-parser: where a request resolves its tenant, and whether each GORM
 * query on its path is constrained by a tenant signal.
 *
 * Matching is by identifier/string token: a token matches a signal when, lowercased
 * with `_` removed, it contains the signal (so "tenant" matches `tenant_id`,
 * `TenantID`, `TenantScope`). Syntactic only: GORM global scopes, callbacks
 * (`db.Callback()`), and a `Scopes(fn)` whose name carries no signal are not seen.
 */

export interface IsolationOptions {
  /** Tokens that mark a query as tenant-constrained. */
  tenantSignals?: string[]
  /** Tokens that mark a Gin context key, middleware or accessor as the request's tenant. */
  tenantContextKeys?: string[]
}

export const DEFAULT_TENANT_SIGNALS = ["tenant", "organization_id", "org_id"]
export const DEFAULT_TENANT_CONTEXT_KEYS = ["tenant", "organization", "org_id"]

export type TokenMatcher = (text: string) => boolean

export function tokenMatcher(words: string[]): TokenMatcher {
  const needles = words.map((w) => w.toLowerCase().replace(/_/g, "")).filter(Boolean)
  return (text) => {
    const tokens = text.match(/[A-Za-z0-9_]+/g) ?? []
    return tokens.some((t) => {
      const token = t.toLowerCase().replace(/_/g, "")
      return needles.some((n) => token.includes(n))
    })
  }
}

// ---------------------------------------------------------------------------
// Tenant context
// ---------------------------------------------------------------------------

/** gin.Context / context.Context getters that read a value set earlier (by middleware). */
const CONTEXT_GETTERS = new Set([
  "Get", "MustGet", "GetString", "GetInt", "GetInt64", "GetUint", "GetUint64", "GetStringMap", "Value",
])

/** Accessor helpers: GetTenantID(c), CurrentTenant(c), tenant.FromContext(ctx). */
const ACCESSOR_NAME = /^(get|current|must|resolve|load)|from(context|ctx)$/i

export interface TenantContextRead {
  symbol: string
  file:   string
  line:   number
}

/** The first place in `method` that reads the request's tenant, or null. */
export function findTenantContextRead(method: HandlerMethod, keyMatch: TokenMatcher): TenantContextRead | null {
  const body = method.node.childForFieldName("body")
  if (!body) return null
  const contextParams = new Set(
    [...functionParamTypes(method.node)].filter(([, type]) => type === "Context").map(([name]) => name),
  )

  for (const node of findCalls(body)) {
    const parts = callParts(node)
    if (!parts) continue
    const key = parts.args[0]
    const isContextGetter =
      CONTEXT_GETTERS.has(parts.method) &&
      !!parts.receiver && contextParams.has(parts.receiver) &&
      !!key && keyMatch(key.text)
    const receiverTail = parts.receiver?.slice(parts.receiver.lastIndexOf(".") + 1) ?? ""
    const isAccessor =
      ACCESSOR_NAME.test(parts.method) &&
      (keyMatch(parts.method) || (!!receiverTail && keyMatch(receiverTail)))
    if (isContextGetter || isAccessor) {
      return { symbol: shorten(node.text), file: method.file, line: node.startPosition.row + 1 }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// GORM queries
// ---------------------------------------------------------------------------

const READ_OPS  = new Set(["First", "Find", "Take", "Last", "Scan", "Count", "Pluck", "FirstOrInit", "Raw"])
const WRITE_OPS = new Set(["Create", "Save", "Update", "Updates", "UpdateColumn", "UpdateColumns", "Delete", "FirstOrCreate", "Exec"])

/** Chain methods that only a *gorm.DB has in practice. */
const GORM_CHAIN = new Set([
  "Model", "Table", "Where", "Not", "Or", "Preload", "Joins", "InnerJoins", "Scopes", "Unscoped", "WithContext",
  "Session", "Select", "Omit", "Order", "Limit", "Offset", "Group", "Having", "Debug", "Clauses", "Distinct",
])

/** Names a *gorm.DB variable or field usually goes by. */
const DB_NAMES = new Set(["db", "DB", "tx", "gdb", "orm", "conn", "gormDB", "database"])

export interface GormOperation {
  kind:      "read" | "write"
  operation: string
  model:     string
  scoped:    boolean
  file:      string
  line:      number
}

/**
 * GORM reads and writes in `method`'s body. `receiverFields` maps the method's
 * receiver struct fields to their bare types, so `r.db` typed `*gorm.DB` counts.
 */
export function findGormOperations(
  method: HandlerMethod,
  receiverFields: ReadonlyMap<string, string>,
  signalMatch: TokenMatcher,
): GormOperation[] {
  const body = method.node.childForFieldName("body")
  if (!body) return []
  const paramTypes = functionParamTypes(method.node)
  const out: GormOperation[] = []

  for (const node of findCalls(body)) {
    const parts = callParts(node)
    if (!parts) continue
    const kind = READ_OPS.has(parts.method) ? "read" : WRITE_OPS.has(parts.method) ? "write" : null
    if (!kind) continue

    const { base, calls } = chainOf(node)
    const baseAssignments = base?.type === "identifier" ? assignmentsTo(body, base.text) : []
    const chainIsGorm = calls.slice(1).some((c) => GORM_CHAIN.has(callParts(c)?.method ?? ""))
    const baseIsGorm =
      isDbExpression(base, paramTypes, receiverFields) ||
      baseAssignments.some((text) => /\.(db|DB|tx)\b|\.(Where|Model|Table|WithContext|Scopes)\(/.test(text))
    if (!chainIsGorm && !baseIsGorm) continue

    const texts = [node.text, ...baseAssignments]
    if (kind === "write") texts.push(...statementsMentioning(body, destinationVar(parts.args[0])))

    out.push({
      kind,
      operation: parts.method,
      model:     modelOf(calls, parts.args[0], body) ?? "gorm",
      scoped:    texts.some(signalMatch),
      file:      method.file,
      line:      node.startPosition.row + 1,
    })
  }
  return out
}

/** The receiver chain of a call: `r.db.Where(...).First(&x)` → base `r.db`, calls [First, Where]. */
function chainOf(call: SyntaxNode): { base: SyntaxNode | null; calls: SyntaxNode[] } {
  const calls = [call]
  let operand = selectorOperand(call)
  while (operand && operand.type === "call_expression") {
    calls.push(operand)
    operand = selectorOperand(operand)
  }
  return { base: operand, calls }
}

function selectorOperand(call: SyntaxNode): SyntaxNode | null {
  const fn = call.childForFieldName("function")
  return fn?.type === "selector_expression" ? fn.childForFieldName("operand") : null
}

function isDbExpression(
  base: SyntaxNode | null,
  paramTypes: ReadonlyMap<string, string>,
  receiverFields: ReadonlyMap<string, string>,
): boolean {
  if (!base) return false
  if (base.type === "identifier") return paramTypes.get(base.text) === "DB" || DB_NAMES.has(base.text)
  if (base.type === "selector_expression") {
    const field = base.childForFieldName("field")?.text ?? ""
    return receiverFields.get(field) === "DB" || DB_NAMES.has(field)
  }
  return false
}

/** Texts of `name := ...` / `name = ...` / `var name = ...` statements in a body. */
function assignmentsTo(body: SyntaxNode, name: string): string[] {
  const out: string[] = []
  for (const n of walk(body)) {
    if (n.type !== "short_var_declaration" && n.type !== "assignment_statement" && n.type !== "var_spec") continue
    const left = n.childForFieldName("left") ?? n.childForFieldName("name")
    if (left && (left.text.split(/\s*,\s*/).includes(name))) out.push(n.text)
  }
  return out
}

/** `&order` / `order` → "order"; anything else → null. */
function destinationVar(arg: SyntaxNode | undefined): string | null {
  if (!arg) return null
  const m = /^&?([A-Za-z_]\w*)$/.exec(arg.text)
  return m ? m[1] : null
}

/** Statements in a body that mention `name` as a whole word (its literal, its field writes). */
function statementsMentioning(body: SyntaxNode, name: string | null): string[] {
  if (!name) return []
  const word = new RegExp(`\\b${name}\\b`)
  const out: string[] = []
  for (const n of walk(body)) {
    if (!/(_statement|_declaration)$/.test(n.type) || n.type === "block") continue
    if (n.type === "if_statement" || n.type === "for_statement" || n.type === "expression_switch_statement") continue
    if (word.test(n.text)) out.push(n.text)
  }
  return out
}

/** Model name from `Model(&T{})`, `Table("t")`, a composite-literal argument, or the destination variable's declaration. */
function modelOf(calls: SyntaxNode[], firstArg: SyntaxNode | undefined, body: SyntaxNode): string | null {
  for (const c of calls) {
    const p = callParts(c)
    if (p?.method === "Model" && p.args[0]) {
      const t = compositeType(p.args[0].text)
      if (t) return t
    }
    if (p?.method === "Table" && p.args[0]) return p.args[0].text.replace(/^["`]|["`]$/g, "")
  }
  if (!firstArg) return null
  const literal = compositeType(firstArg.text)
  if (literal) return literal
  const name = destinationVar(firstArg)
  if (!name) return null
  const decl =
    new RegExp(`\\bvar\\s+${name}\\s+(?:\\[\\])?\\*?(?:\\w+\\.)?(\\w+)`).exec(body.text) ??
    new RegExp(`\\b${name}\\s*:?=\\s*(?:&|new\\()?(?:\\[\\])?\\*?(?:\\w+\\.)?(\\w+)\\s*[{)]`).exec(body.text)
  return decl ? decl[1] : null
}

/** `&models.Order{}` / `Order{...}` / `[]Order{}` → "Order". */
function compositeType(text: string): string | null {
  const m = /^&?(?:\[\])?\*?(?:\w+\.)?([A-Z]\w*)\s*\{/.exec(text.trim())
  return m ? m[1] : null
}

function shorten(text: string): string {
  const firstLine = text.split("\n")[0]
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine
}

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

/**
 * The first place in `method` that reads the request's tenant, or null:
 *  - a getter on the request context with a tenant key: `c.GetString("tenant_id")`;
 *  - an accessor named for the tenant: `GetTenantID(c)`, `tenant.FromContext(ctx)`;
 *  - a function named for the tenant handed the request context: `tenanthelper.TenantScope(c)`;
 *  - a field named for the tenant read off a value: `claims.TenantID` (JWT claims put
 *    in the context by middleware).
 */
export function findTenantContextRead(method: HandlerMethod, keyMatch: TokenMatcher): TenantContextRead | null {
  const body = method.node.childForFieldName("body")
  if (!body) return null
  const contextParams = new Set(
    [...functionParamTypes(method.node)].filter(([, type]) => type === "Context").map(([name]) => name),
  )
  const at = (node: SyntaxNode): TenantContextRead => ({ symbol: shorten(node.text), file: method.file, line: node.startPosition.row + 1 })

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
    const isTenantFunctionOfContext =
      keyMatch(parts.method) && parts.args.some((a) => contextParams.has(a.text))
    if (isContextGetter || isAccessor || isTenantFunctionOfContext) return at(node)
  }
  for (const node of walk(body)) {
    if (node.type !== "selector_expression") continue
    const operand = node.childForFieldName("operand")
    const field = node.childForFieldName("field")
    if (operand?.type === "identifier" && field && keyMatch(field.text)) return at(node)
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

/** Methods a DAO / repository / model wrapper exposes for reads and writes, beyond GORM's own. */
const DAO_READ_OPS  = new Set([...READ_OPS, "Get", "GetByID", "GetById", "FindByID", "FindById", "FindOne", "List", "Page", "Query", "Exists"])
const DAO_WRITE_OPS = new Set([...WRITE_OPS, "Insert", "Remove", "Upsert", "BatchCreate", "CreateInBatches"])

/** Which GORM callback chain an operation goes through. */
function callbackOf(operation: string, kind: "read" | "write"): "create" | "update" | "delete" | "query" {
  if (kind === "read") return "query"
  if (/^(Delete|Remove)$/.test(operation)) return "delete"
  if (/^(Update|Updates|UpdateColumn|UpdateColumns)$/.test(operation)) return "update"
  return "create"
}

/** What findGormOperations needs to see past plain GORM chains. */
export interface DataAccessContext {
  /** Type of a receiver expression at a call site in the method (`db`, `s.repo`, `service.GroupApp.Board`). */
  resolveType:  (receiver: string) => string | null
  /** Whether a type is a DAO / repository / model (declared under dal/, models/, ... or named so). */
  isDataType:   (typeName: string) => boolean
  /** Argument text at the call site that reached this method, for scopes passed in (`Scopes(funcs...)`). */
  callerArgs:   string
  /** GORM callbacks that add the tenant on their own (a create hook that sets TenantID). */
  tenantHooks:  ReadonlySet<"create" | "update" | "delete" | "query">
  /** The project method a call resolves to, if any. */
  calleeOf:     (typeName: string, method: string) => HandlerMethod | null
  /** The method's variadic parameters (`scopes ...func(*gorm.DB) *gorm.DB`): conditions its caller hands in. */
  passedParams: ReadonlySet<string>
}

/** `Preload("Tenant")` loads a relation, it does not filter rows: drop it before looking for a tenant signal. */
function withoutPreloads(text: string): string {
  return text.replace(/\.Preload\(\s*("[^"]*"|`[^`]*`)[^)]*\)/g, "")
}

/** Whether any text forwards one of the method's variadic parameters (`scopes...`). */
function forwardsPassedParam(texts: string[], params: ReadonlySet<string>): boolean {
  return [...params].some((p) => texts.some((t) => new RegExp(`\\b${p}\\s*\\.\\.\\.`).test(t)))
}

/** The names of a function's variadic parameters. */
export function variadicParamNames(fn: SyntaxNode): Set<string> {
  const out = new Set<string>()
  for (const p of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    if (p.type !== "variadic_parameter_declaration") continue
    const name = p.childForFieldName("name")?.text
    if (name) out.add(name)
  }
  return out
}

export interface DaoCall {
  kind:   "read" | "write"
  type:   string
  scoped: boolean
  /**
   * Whether the call is judged where it is made instead of inside the callee:
   * the callee takes its conditions from the caller (`First(ctx, option ...gen.Condition)`,
   * `Find(c, funcs ...func(*gorm.DB) *gorm.DB)`) or is not in the project, or it is
   * a write whose record the caller has already tied to the tenant.
   */
  leaf:   boolean
}

/** A read/write-named call on a DAO, repository or model wrapper, or null. */
export function daoCall(call: SyntaxNode, body: SyntaxNode, data: DataAccessContext, signalMatch: TokenMatcher): DaoCall | null {
  const parts = callParts(call)
  if (!parts?.receiver) return null
  const kind = DAO_READ_OPS.has(parts.method) ? "read" : DAO_WRITE_OPS.has(parts.method) ? "write" : null
  if (!kind) return null
  const type = data.resolveType(parts.receiver)
  if (!type || !data.isDataType(type)) return null

  const texts = [call.text]
  for (const a of parts.args) {
    const name = /^([A-Za-z_]\w*)(\.\.\.)?$/.exec(a.text)?.[1]
    if (name) texts.push(...assignmentsTo(body, name))   // queryScopes := append(..., scopes...)
  }
  if (kind === "write") for (const a of parts.args) texts.push(...statementsMentioning(body, destinationVar(a)))
  const scoped = texts.some((t) => signalMatch(withoutPreloads(t))) ||
    (forwardsPassedParam(texts, data.passedParams) && signalMatch(data.callerArgs)) ||
    data.tenantHooks.has(callbackOf(parts.method, kind))

  const callee = data.calleeOf(type, parts.method)
  const takesConditions = !callee || hasVariadicParameter(callee.node)
  return { kind, type, scoped, leaf: takesConditions || (kind === "write" && scoped) }
}

function hasVariadicParameter(fn: SyntaxNode): boolean {
  return fn.childForFieldName("parameters")?.namedChildren.some((p) => p.type === "variadic_parameter_declaration") ?? false
}

/**
 * GORM reads and writes in `method`'s body. `receiverFields` maps the method's
 * receiver struct fields to their bare types, so `r.db` typed `*gorm.DB` counts.
 * With `data`, a read/write-named call on a DAO or model wrapper
 * (`db.First(ctx, query.Board.TenantID.Eq(t))`, `list.Find(c, TenantScope(c))`)
 * counts too, scoped by its arguments; a scope a wrapper receives as a parameter
 * (`Scopes(funcs...)`) is judged by the arguments at the call site that reached it;
 * and an operation whose GORM callback adds the tenant counts as scoped.
 */
export function findGormOperations(
  method: HandlerMethod,
  receiverFields: ReadonlyMap<string, string>,
  signalMatch: TokenMatcher,
  data?: DataAccessContext,
): GormOperation[] {
  const body = method.node.childForFieldName("body")
  if (!body) return []
  const paramTypes = functionParamTypes(method.node)
  const out: GormOperation[] = []

  for (const node of findCalls(body)) {
    const parts = callParts(node)
    if (!parts) continue

    // a DAO / repository / model wrapper call, checked first so a wrapper held in a
    // variable named `db` (db := dal.UserQuery{}) is not taken for *gorm.DB.
    // Judged here when it is a leaf (db.First(ctx, query.Board.TenantID.Eq(t)),
    // list.Find(c, scopes...)); otherwise followed into the callee (see methodsOnPath).
    const dao = data ? daoCall(node, body, data, signalMatch) : null
    if (dao) {
      if (dao.leaf) {
        out.push({
          kind: dao.kind, operation: parts.method, model: dao.type, scoped: dao.scoped,
          file: method.file, line: node.startPosition.row + 1,
        })
      }
      continue
    }

    const { base, calls } = chainOf(node)
    const kind = READ_OPS.has(parts.method) ? "read" : WRITE_OPS.has(parts.method) ? "write" : null
    const baseAssignments = base?.type === "identifier" ? assignmentsTo(body, base.text) : []
    const chainIsGorm = !!kind && calls.slice(1).some((c) => GORM_CHAIN.has(callParts(c)?.method ?? ""))
    const baseIsGorm = !!kind && (
      isDbExpression(base, paramTypes, receiverFields) ||
      baseAssignments.some((text) => /\.(db|DB|tx)\b|\.(Where|Model|Table|WithContext|Scopes)\(/.test(text)))

    if (chainIsGorm || baseIsGorm) {
      const texts = [node.text, ...baseAssignments]
      // a subquery or condition built in a variable: Where("device_id IN (?)", devices)
      for (const c of calls) {
        for (const a of callParts(c)?.args ?? []) {
          if (a.type === "identifier" && a.text !== base?.text) texts.push(...assignmentsTo(body, a.text))
        }
      }
      if (kind === "write") texts.push(...statementsMentioning(body, destinationVar(parts.args[0])))
      // a scope handed in by the caller: Scopes(funcs...) with funcs a parameter
      const passedScope = calls.some((c) => {
        const p = callParts(c)
        return p?.method === "Scopes" && p.args.some((a) => paramTypes.has(a.text.replace(/\.\.\.$/, "")) || /\.\.\.$/.test(a.text))
      })
      const scoped = texts.some((t) => signalMatch(withoutPreloads(t))) ||
        (passedScope && !!data && signalMatch(data.callerArgs)) ||
        (!!data && data.tenantHooks.has(callbackOf(parts.method, kind!)))
      out.push({
        kind: kind!,
        operation: parts.method,
        model:     modelOf(calls, parts.args[0], body) ?? valueModel(parts.args[0], data) ??
                   genModel(base, baseAssignments) ?? "gorm",
        scoped,
        file:      method.file,
        line:      node.startPosition.row + 1,
      })
    }
  }
  return out
}

/** First(t) on the receiver or a typed local: the model is that value's type, when it is a project model. */
function valueModel(arg: SyntaxNode | undefined, data: DataAccessContext | undefined): string | null {
  const name = destinationVar(arg)
  if (!name || !data) return null
  const type = data.resolveType(name)
  return type && data.isDataType(type) ? type : null
}

/** gorm-gen: `query.Device.WithContext(ctx)...First()` or `users := query.User; users.Where(...)` → the model name. */
function genModel(base: SyntaxNode | null, baseAssignments: string[]): string | null {
  const texts = [base?.text ?? "", ...baseAssignments.map((a) => a.split(/:?=/).pop()!.trim())]
  for (const t of texts) {
    const m = /^\w+\.([A-Z]\w*)$/.exec(t)
    if (m) return m[1]
  }
  return null
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
/**
 * Assignments in a body, by assigned name. Built once per body (one walk) and
 * kept per tree, keyed by the body's span: tree-sitter does not guarantee one
 * JS object per node, so nodes are not used as keys.
 */
const assignmentIndex = new WeakMap<object, Map<string, Map<string, string[]>>>()

function assignmentsIn(body: SyntaxNode): Map<string, string[]> {
  let perTree = assignmentIndex.get(body.tree)
  if (!perTree) { perTree = new Map(); assignmentIndex.set(body.tree, perTree) }
  const key = `${body.startIndex}:${body.endIndex}`
  let byName = perTree.get(key)
  if (!byName) {
    byName = new Map()
    for (const n of walk(body)) {
      if (n.type !== "short_var_declaration" && n.type !== "assignment_statement" && n.type !== "var_spec") continue
      const left = n.childForFieldName("left") ?? n.childForFieldName("name")
      if (!left) continue
      for (const name of new Set(left.text.split(/\s*,\s*/))) {
        byName.set(name, [...(byName.get(name) ?? []), n.text])
      }
    }
    perTree.set(key, byName)
  }
  return byName
}

function assignmentsTo(body: SyntaxNode, name: string): string[] {
  return assignmentsIn(body).get(name) ?? []
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

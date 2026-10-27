import { walk, type SyntaxNode } from "@kidkender/archmind-go-parser"
import { collectFacts, type Decl, type GoFile } from "./parse.js"

export interface UnscopedAccess {
  kind: "unscoped_resource_access"
  /** `Type.Method` or `Func`: takes a caller identity and a resource id but never relates the two. */
  function: string
  file: string
  line: number
  caller: string
  resources: string[]
}

const MAX_DEPTH = 3
const IDENTITY_NAME = /^(character|user|account|player|caller|actor|owner)(ID|Id)$/
const RESOURCE_NAME = /^id$|(ID|Id)$/
const ID_TYPE = /^(u?int(8|16|32|64)?|string|UUID)$/
/** Query-builder methods whose arguments are conditions: a chain whose conditions mention both sides ties the resource to the caller. */
const CONDITION_METHODS = new Set(["Where", "First", "Take", "Last", "Find", "Count", "Not", "Or"])
/** Methods that end a chain; the arguments of Create, Save, Update and Delete are values written, not conditions. */
const QUERY_METHODS = new Set([...CONDITION_METHODS, "Scan", "Pluck", "Delete", "Update", "Updates", "Save", "Create"])

interface Tag {
  caller: boolean
  resource: boolean
}
type Tags = Map<string, Tag>

const NONE: Tag = { caller: false, resource: false }
const merge = (a: Tag, b: Tag): Tag => ({ caller: a.caller || b.caller, resource: a.resource || b.resource })
const both = (t: Tag): boolean => t.caller && t.resource
const dirOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1)
const isTest = (path: string): boolean => path.endsWith("_test.go")

function identifiers(node: SyntaxNode): string[] {
  const out: string[] = []
  for (const n of walk(node)) if (n.type === "identifier") out.push(n.text)
  return out
}

function tagOf(node: SyntaxNode, tags: Tags, skip?: Set<string>): Tag {
  let t = NONE
  for (const id of identifiers(node)) if (!skip?.has(id)) t = merge(t, tags.get(id) ?? NONE)
  return t
}

/** The method name a call ends in: `s.db.Where(...)` gives "Where"; a plain call gives its function name. */
function calleeName(call: SyntaxNode): { name: string; selector: boolean } | null {
  const fn = call.childForFieldName("function")
  if (!fn) return null
  if (fn.type === "identifier") return { name: fn.text, selector: false }
  if (fn.type === "selector_expression") {
    const field = fn.childForFieldName("field")
    return field ? { name: field.text, selector: true } : null
  }
  return null
}

/** Variables an assignment or declaration defines: the left-hand identifiers. */
function definedNames(stmt: SyntaxNode): string[] {
  const left = stmt.childForFieldName("left")
  return left ? identifiers(left) : []
}

/** What the conditions of a query chain mention, without the variables the chain fills in. */
function conditionTag(chain: SyntaxNode, tags: Tags, skip: Set<string>): Tag {
  let t = NONE
  for (const n of walk(chain)) {
    if (n.type !== "call_expression" || !CONDITION_METHODS.has(calleeName(n)?.name ?? "")) continue
    const args = n.childForFieldName("arguments")
    if (args) t = merge(t, tagOf(args, tags, skip))
  }
  return t
}

function addressedNames(call: SyntaxNode): string[] {
  const out: string[] = []
  for (const n of walk(call)) {
    if (n.type !== "unary_expression" || n.child(0)?.text !== "&") continue
    const operand = n.namedChildren[0]
    if (operand?.type === "identifier") out.push(operand.text)
  }
  return out
}

interface Resolver {
  resolve(from: Decl, name: string, selector: boolean): Decl | null
}

/** True when the function relates a caller-derived value to a resource-derived one, directly or through a function it forwards both to. */
function relates(decl: Decl, callerParams: Set<string>, resourceParams: Set<string>, depth: number, r: Resolver, seen: Set<string>): boolean {
  const body = decl.node.childForFieldName("body")
  if (!body) return false
  const tags: Tags = new Map()
  for (const p of callerParams) tags.set(p, { caller: true, resource: false })
  for (const p of resourceParams) tags.set(p, merge(tags.get(p) ?? NONE, { caller: false, resource: true }))

  for (const n of walk(body)) {
    if (n.type === "binary_expression") {
      const op = n.childForFieldName("operator")?.text
      const isNil = n.namedChildren.some((c) => c.type === "nil")
      if ((op === "==" || op === "!=") && !isNil && both(tagOf(n, tags))) return true
    }
    if ((n.type === "short_var_declaration" || n.type === "assignment_statement") && n.childForFieldName("right")) {
      const t = tagOf(n.childForFieldName("right")!, tags)
      for (const name of definedNames(n)) tags.set(name, t)
    }
    if (n.type !== "call_expression") continue
    const callee = calleeName(n)
    if (!callee) continue
    if (callee.selector && QUERY_METHODS.has(callee.name)) {
      const out = new Set(addressedNames(n))
      const t = conditionTag(n, tags, out)
      if (both(t)) return true
      for (const name of out) tags.set(name, merge(tags.get(name) ?? NONE, t))
      continue
    }
    if (depth >= MAX_DEPTH) continue
    const target = r.resolve(decl, callee.name, callee.selector)
    if (!target) continue
    const args = n.childForFieldName("arguments")?.namedChildren ?? []
    const names = [...target.params.keys()]
    const callerNext = new Set<string>()
    const resourceNext = new Set<string>()
    args.forEach((arg, i) => {
      const t = tagOf(arg, tags)
      if (names[i] && t.caller) callerNext.add(names[i])
      if (names[i] && t.resource) resourceNext.add(names[i])
    })
    if (callerNext.size === 0 || resourceNext.size === 0) continue
    const key = `${target.file}:${target.recv ?? ""}.${target.name}:${[...callerNext]}:${[...resourceNext]}`
    if (seen.has(key)) continue
    seen.add(key)
    if (relates(target, callerNext, resourceNext, depth + 1, r, seen)) return true
  }
  return false
}

function makeResolver(decls: Decl[]): Resolver {
  const byName = new Map<string, Decl[]>()
  for (const d of decls) byName.set(d.name, [...(byName.get(d.name) ?? []), d])
  return {
    resolve(from, name, selector) {
      const all = byName.get(name) ?? []
      if (selector) return all.filter((d) => d.recv).length === 1 ? (all.find((d) => d.recv) ?? null) : null
      const sameDir = all.filter((d) => !d.recv && dirOf(d.file) === dirOf(from.file))
      return sameDir.length === 1 ? sameDir[0] : null
    },
  }
}

/**
 * Functions that take a caller identity and a resource id and never relate the two: no comparison, no
 * query and no forwarded helper links something derived from the caller to something derived from the id.
 * A candidate for a missing ownership check (a caller acting on another caller's resource). It is a
 * heuristic about syntax, not a proof of an exposure: authorization done outside these functions is not seen.
 */
export function findUnscopedAccess(files: GoFile[]): UnscopedAccess[] {
  const decls = collectFacts(files.filter((f) => !isTest(f.path))).facts.flatMap((f) => f.decls)
  const resolver = makeResolver(decls)
  const out: UnscopedAccess[] = []
  for (const d of decls) {
    const idParams = [...d.params].filter(([, type]) => ID_TYPE.test(type))
    const caller = idParams.find(([name]) => IDENTITY_NAME.test(name))?.[0]
    const resources = idParams.map(([name]) => name).filter((name) => name !== caller && !IDENTITY_NAME.test(name) && RESOURCE_NAME.test(name))
    if (!caller || resources.length === 0) continue
    if (relates(d, new Set([caller]), new Set(resources), 0, resolver, new Set())) continue
    out.push({ kind: "unscoped_resource_access", function: d.recv ? `${d.recv}.${d.name}` : d.name, file: d.file, line: d.node.startPosition.row + 1, caller, resources })
  }
  return out
}

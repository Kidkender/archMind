import { walk, bareTypeName, type SyntaxNode } from "@kidkender/archmind-go-parser"
import { collectFacts, elementTypeName, type Decl, type FieldElems, type FieldTypes, type FileFacts, type GoFile } from "./parse.js"

export type { GoFile } from "./parse.js"

export type EdgeVia = "call" | "go" | "callback"

export interface FuncDef {
  /** `${file}:${key}` */
  id: string
  /** "Recv.Method", "Func", or "callback:Field" for a func literal assigned to a struct field. */
  key: string
  name: string
  recv: string | null
  file: string
  dir: string
  line: number
}

export interface CallEdge {
  from: string
  to: string
  line: number
  inTxn: boolean
  via: EdgeVia
}

export interface CallGraph {
  defs: Map<string, FuncDef>
  edgesFrom(id: string): CallEdge[]
  edgesTo(id: string): CallEdge[]
  /** Definitions matching "Recv.Method", a bare function, or a bare method name. */
  findDefs(symbol: string): FuncDef[]
}

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1)
const lastSegment = (dir: string): string => dir.replace(/\/$/, "").split("/").pop() ?? ""
const nodeKey = (n: SyntaxNode): string => `${n.type}:${n.startIndex}:${n.endIndex}`

interface Index {
  methodsByName: Map<string, FuncDef[]>
  methodsByRecv: Map<string, FuncDef[]>
  funcsByDir: Map<string, FuncDef[]>
  callbacksByField: Map<string, FuncDef[]>
  /** `${dir}${name}` or `${Recv}.${name}` to the bare type of its first result. */
  returns: Map<string, string>
}

function addTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** Walks up from a call: is it inside a func literal passed to `.Transaction(...)`? */
function isInTransaction(call: SyntaxNode): boolean {
  for (let n = call.parent; n; n = n.parent) {
    if (n.type === "function_declaration" || n.type === "method_declaration") return false
    if (n.type !== "func_literal") continue
    const args = n.parent
    const outer = args?.parent
    if (args?.type !== "argument_list" || outer?.type !== "call_expression") continue
    const callee = outer.childForFieldName("function")
    if (callee?.type === "selector_expression" && callee.childForFieldName("field")?.text === "Transaction") return true
  }
  return false
}

/** The `x.Field = func(...) {...}` assignments inside a declaration. */
function callbackLiterals(decl: Decl): Map<string, { field: string; literal: SyntaxNode }> {
  const out = new Map<string, { field: string; literal: SyntaxNode }>()
  for (const n of walk(decl.node)) {
    if (n.type !== "assignment_statement") continue
    const left = n.childForFieldName("left")?.namedChildren[0]
    const right = n.childForFieldName("right")?.namedChildren[0]
    if (left?.type !== "selector_expression" || right?.type !== "func_literal") continue
    const field = left.childForFieldName("field")?.text
    if (field) out.set(nodeKey(right), { field, literal: right })
  }
  return out
}

function makeDef(file: string, key: string, name: string, recv: string | null, node: SyntaxNode): FuncDef {
  return { id: `${file}:${key}`, key, name, recv, file, dir: dirOf(file), line: node.startPosition.row + 1 }
}

function buildIndex(facts: FileFacts[]): { index: Index; defs: Map<string, FuncDef>; callbackOwners: Map<string, FuncDef> } {
  const index: Index = { methodsByName: new Map(), methodsByRecv: new Map(), funcsByDir: new Map(), callbacksByField: new Map(), returns: new Map() }
  const defs = new Map<string, FuncDef>()
  const callbackOwners = new Map<string, FuncDef>() // `${file}:${literal nodeKey}` -> callback def
  for (const ff of facts) {
    for (const d of ff.decls) {
      const def = makeDef(d.file, d.recv ? `${d.recv}.${d.name}` : d.name, d.name, d.recv, d.node)
      defs.set(def.id, def)
      if (d.recv) {
        addTo(index.methodsByName, d.name, def)
        addTo(index.methodsByRecv, `${d.recv}.${d.name}`, def)
        if (d.returns) index.returns.set(`${d.recv}.${d.name}`, d.returns)
      } else {
        addTo(index.funcsByDir, `${def.dir}${d.name}`, def)
        if (d.returns) index.returns.set(`${def.dir}${d.name}`, d.returns)
      }
      for (const [k, cb] of callbackLiterals(d)) {
        const cbDef = makeDef(d.file, `callback:${cb.field}`, cb.field, null, cb.literal)
        defs.set(cbDef.id, cbDef)
        addTo(index.callbacksByField, cb.field, cbDef)
        callbackOwners.set(`${d.file}:${k}`, cbDef)
      }
    }
  }
  return { index, defs, callbackOwners }
}

interface Resolver {
  ff: FileFacts
  decl: Decl
  fieldTypes: FieldTypes
  fieldElems: FieldElems
  index: Index
  /** Element types of slice and map variables. */
  localElems: Map<string, string>
  /** Variables declared inside the function, typed where the right-hand side makes the type clear. */
  locals: Map<string, string>
}

/** The type a selector operand has, when it can be read from the receiver, a typed parameter, or a struct field. */
function operandType(operand: SyntaxNode, r: Resolver): string | null {
  const typeOfIdent = (name: string): string | null =>
    r.locals.get(name) ?? (name === r.decl.recvVar ? r.decl.recv : (r.decl.params.get(name) ?? null))
  if (operand.type === "identifier") return typeOfIdent(operand.text)
  if (operand.type !== "selector_expression") return null
  const inner = operand.childForFieldName("operand")
  const field = operand.childForFieldName("field")?.text
  if (inner?.type !== "identifier" || !field) return null
  const owner = typeOfIdent(inner.text)
  return owner ? (r.fieldTypes.get(owner)?.get(field) ?? null) : null
}

/** The directory entries of a package-qualified function `pkg.name`, as index keys. */
function packageFuncKeys(r: Resolver, pkg: string, name: string): string[] {
  return [...r.index.funcsByDir.keys()].filter((k) => k.endsWith(name) && lastSegment(k.slice(0, k.length - name.length)) === pkg)
}

function isPackageName(ident: SyntaxNode, r: Resolver): boolean {
  return r.ff.imports.has(ident.text) && ident.text !== r.decl.recvVar && !r.decl.params.has(ident.text) && !r.locals.has(ident.text)
}

/** The type an expression has, when it is a composite literal, a constructor call, a field or a known variable. */
function inferType(expr: SyntaxNode, r: Resolver): string | null {
  switch (expr.type) {
    case "unary_expression":
      return inferType(expr.childForFieldName("operand") ?? expr, r)
    case "composite_literal": {
      const type = expr.childForFieldName("type")
      return type ? bareTypeName(type) : null
    }
    case "identifier":
      return r.locals.get(expr.text) ?? (expr.text === r.decl.recvVar ? r.decl.recv : (r.decl.params.get(expr.text) ?? null))
    case "selector_expression":
      return operandType(expr, r)
    case "call_expression":
      return callReturnType(expr, r)
    default:
      return null
  }
}

function callReturnType(call: SyntaxNode, r: Resolver): string | null {
  const fn = call.childForFieldName("function")
  if (fn?.type === "identifier") return r.index.returns.get(`${dirOf(r.ff.file)}${fn.text}`) ?? null
  if (fn?.type !== "selector_expression") return null
  const operand = fn.childForFieldName("operand")
  const name = fn.childForFieldName("field")?.text
  if (!operand || !name) return null
  if (operand.type === "identifier" && isPackageName(operand, r)) {
    const key = packageFuncKeys(r, r.ff.imports.get(operand.text)!, name)[0]
    return key ? (r.index.returns.get(key) ?? null) : null
  }
  const type = operandType(operand, r)
  return type ? (r.index.returns.get(`${type}.${name}`) ?? null) : null
}

/** The element type of a slice or map expression: a field, a parameter, a variable, a literal or `make(...)`. */
function inferElem(expr: SyntaxNode, r: Resolver): string | null {
  switch (expr.type) {
    case "identifier":
      return r.localElems.get(expr.text) ?? r.decl.paramElems.get(expr.text) ?? null
    case "selector_expression": {
      const operand = expr.childForFieldName("operand")
      const field = expr.childForFieldName("field")?.text
      const owner = operand ? operandType(operand, r) : null
      return owner && field ? (r.fieldElems.get(owner)?.get(field) ?? null) : null
    }
    case "unary_expression":
      return inferElem(expr.childForFieldName("operand") ?? expr, r)
    case "composite_literal": {
      const type = expr.childForFieldName("type")
      return type ? elementTypeName(type) : null
    }
    case "call_expression": {
      const fn = expr.childForFieldName("function")
      const first = expr.childForFieldName("arguments")?.namedChildren[0]
      return fn?.type === "identifier" && fn.text === "make" && first ? elementTypeName(first) : null
    }
    default:
      return null
  }
}

/** Types the variables declared in a function (`x := ...`, `var x T`, `for _, v := range xs`), in source order. */
function inferLocals(r: Resolver): void {
  for (const n of walk(r.decl.node)) {
    if (n.type === "short_var_declaration") {
      const names = n.childForFieldName("left")?.namedChildren ?? []
      const first = n.childForFieldName("right")?.namedChildren[0]
      const type = first ? inferType(first, r) : null
      const elem = first ? inferElem(first, r) : null
      if (names[0]?.type === "identifier" && names[0].text !== "_") {
        if (type) r.locals.set(names[0].text, type)
        if (elem) r.localElems.set(names[0].text, elem)
      }
    } else if (n.type === "var_spec") {
      const type = n.childForFieldName("type")
      const bare = type ? bareTypeName(type) : null
      const elem = type ? elementTypeName(type) : null
      for (const id of n.namedChildren) {
        if (id.type !== "identifier") continue
        if (bare) r.locals.set(id.text, bare)
        if (elem) r.localElems.set(id.text, elem)
      }
    } else if (n.type === "range_clause") {
      const vars = n.childForFieldName("left")?.namedChildren ?? []
      const source = n.childForFieldName("right")
      const elem = source ? inferElem(source, r) : null
      if (elem && vars.length >= 2 && vars[1].type === "identifier" && vars[1].text !== "_") r.locals.set(vars[1].text, elem)
    }
  }
}

function uniqueMethod(name: string, r: Resolver): FuncDef[] {
  const all = r.index.methodsByName.get(name) ?? []
  return all.length === 1 ? all : []
}

function resolveSelector(fn: SyntaxNode, r: Resolver): { targets: FuncDef[]; via: EdgeVia } {
  const operand = fn.childForFieldName("operand")
  const name = fn.childForFieldName("field")?.text
  if (!operand || !name) return { targets: [], via: "call" }

  if (operand.type === "identifier" && isPackageName(operand, r)) {
    const keys = packageFuncKeys(r, r.ff.imports.get(operand.text)!, name)
    return { targets: keys.flatMap((k) => r.index.funcsByDir.get(k) ?? []), via: "call" }
  }

  const type = operandType(operand, r)
  if (type) {
    const methods = r.index.methodsByRecv.get(`${type}.${name}`) ?? []
    if (methods.length > 0) return { targets: methods, via: "call" }
    const callbacks = r.index.callbacksByField.get(name) ?? []
    if (callbacks.length > 0) return { targets: callbacks, via: "callback" }
  }
  const unique = uniqueMethod(name, r)
  if (unique.length > 0) return { targets: unique, via: "call" }
  return { targets: r.index.callbacksByField.get(name) ?? [], via: "callback" }
}

function resolveCall(call: SyntaxNode, r: Resolver): { targets: FuncDef[]; via: EdgeVia } {
  const fn = call.childForFieldName("function")
  if (!fn) return { targets: [], via: "call" }
  if (fn.type === "identifier") {
    const dir = dirOf(r.ff.file)
    return { targets: r.index.funcsByDir.get(`${dir}${fn.text}`) ?? [], via: "call" }
  }
  if (fn.type === "selector_expression") return resolveSelector(fn, r)
  return { targets: [], via: "call" }
}

export function buildCallGraph(files: GoFile[]): CallGraph {
  const { facts, fieldTypes, fieldElems } = collectFacts(files)
  const { index, defs, callbackOwners } = buildIndex(facts)
  const from = new Map<string, CallEdge[]>()
  const to = new Map<string, CallEdge[]>()
  const owners = new Map(facts.flatMap((ff) => ff.decls.map((d) => [`${d.file}:${d.node.startIndex}`, d] as const)))
  void owners

  for (const ff of facts) {
    for (const decl of ff.decls) {
      const ownerId = `${decl.file}:${decl.recv ? `${decl.recv}.${decl.name}` : decl.name}`
      const resolver: Resolver = { ff, decl, fieldTypes, fieldElems, index, locals: new Map(), localElems: new Map() }
      inferLocals(resolver)
      for (const call of walk(decl.node)) {
        if (call.type !== "call_expression") continue
        const edgeOwner = enclosingCallback(call, decl, callbackOwners) ?? ownerId
        const { targets, via } = resolveCall(call, resolver)
        const kind: EdgeVia = call.parent?.type === "go_statement" ? "go" : via
        for (const t of targets) {
          if (t.id === edgeOwner) continue
          const edge: CallEdge = { from: edgeOwner, to: t.id, line: call.startPosition.row + 1, inTxn: isInTransaction(call), via: kind }
          addTo(from, edge.from, edge)
          addTo(to, edge.to, edge)
        }
      }
    }
  }

  return {
    defs,
    edgesFrom: (id) => from.get(id) ?? [],
    edgesTo: (id) => to.get(id) ?? [],
    findDefs: (symbol) => [...defs.values()].filter((d) => d.key === symbol || (d.name === symbol && !d.key.startsWith("callback:"))),
  }
}

/** The callback def a call sits inside, if it is within an assigned func literal of this declaration. */
function enclosingCallback(call: SyntaxNode, decl: Decl, owners: Map<string, FuncDef>): string | null {
  for (let n = call.parent; n; n = n.parent) {
    if (n.type === "function_declaration" || n.type === "method_declaration") return null
    if (n.type === "func_literal") {
      const def = owners.get(`${decl.file}:${nodeKey(n)}`)
      if (def) return def.id
    }
  }
  return null
}

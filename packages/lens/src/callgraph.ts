import { walk, bareTypeName, type SyntaxNode } from "@kidkender/archmind-go-parser"
import { bodyFlags, type BodyFlags } from "./flags.js"
import { collectFacts, elementTypeName, type Decl, type FieldElems, type FieldNames, type FieldTypes, type FileFacts, type GoFile, type Interfaces, type PackageVars } from "./parse.js"

export type { GoFile } from "./parse.js"

/** How an edge arises: a written call, a `go` statement, a call through a func-typed field, or a function/method used as a value (called later, somewhere else). */
export type EdgeVia = "call" | "go" | "callback" | "ref"

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
  /** The body calls `.Transaction(...)`: this function opens a database transaction itself. */
  opensTransaction: boolean
  /** The body writes to a field or element, or deletes from a map. */
  mutatesState: boolean
  /** The body calls something named rollback, undo, revert or compensate. */
  compensates: boolean
  /** A parameter is a database handle, so the function takes part in its caller's transaction. */
  takesTx: boolean
  /** A parameter is a web framework's request context: an HTTP handler. */
  takesRequest: boolean
  /** Number of parameters; null for a variadic function, or when not known (func literals). */
  arity: number | null
}

export interface CallEdge {
  from: string
  to: string
  line: number
  inTxn: boolean
  via: EdgeVia
}

/** A call `x.Name(...)` the graph could not attribute to any definition, though methods named `Name` exist. */
export interface UnresolvedCall {
  name: string
  file: string
  line: number
  /** Key of the function the call sits in. */
  caller: string
  /** Number of arguments written in the call. */
  args: number
}

export interface CallGraph {
  defs: Map<string, FuncDef>
  /** Calls of a method named `name` whose receiver is untyped or an interface, and that reached no definition. Test files are left out. */
  unresolvedCalls(name: string): UnresolvedCall[]
  edgesFrom(id: string): CallEdge[]
  edgesTo(id: string): CallEdge[]
  /** Definitions matching "Recv.Method", a bare function, or a bare method name. */
  findDefs(symbol: string): FuncDef[]
  /** True when the struct type has a sync.Mutex or sync.RWMutex field (named or embedded). */
  typeHasMutex(type: string): boolean
}

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1)
const lastSegment = (dir: string): string => dir.replace(/\/$/, "").split("/").pop() ?? ""
const nodeKey = (n: SyntaxNode): string => `${n.type}:${n.startIndex}:${n.endIndex}`

interface Index {
  methodsByName: Map<string, FuncDef[]>
  methodsByRecv: Map<string, FuncDef[]>
  funcsByDir: Map<string, FuncDef[]>
  /** Field name to every function stored in a field of that name, whatever the type. Used when the receiver's type is unknown. */
  callbacksByField: Map<string, FuncDef[]>
  /** Field name to the functions stored in it where the type that owns the field is not known (`x.F = func...`). */
  callbacksUnowned: Map<string, FuncDef[]>
  /** `Type.Field` to the functions stored in that field. */
  callbacksByTypeField: Map<string, FuncDef[]>
  /** `Recv.Method` to the fields a setter stores its parameters in. */
  settersByRecv: Map<string, Setter[]>
  /** Method name to the setters of that name, for a receiver whose type is unknown. */
  settersByName: Map<string, Setter[]>
  /** `${dir}${name}` or `${Recv}.${name}` to the bare type of its first result. */
  returns: Map<string, string>
}

/** A method that stores its `index`-th parameter in `field` of its receiver (`g.block = f`). */
interface Setter {
  recv: string
  field: string
  index: number
}

function addTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (!list) map.set(key, [value])
  else if (!list.includes(value)) list.push(value)
}

/** Records that `field` of `owner` (or of an unknown type) holds each of `targets`, so a call through the field reaches them. */
function storeFunctions(index: Index, owner: string | null, field: string, targets: FuncDef[]): void {
  for (const t of targets) {
    addTo(index.callbacksByField, field, t)
    if (owner) addTo(index.callbacksByTypeField, `${owner}.${field}`, t)
    else addTo(index.callbacksUnowned, field, t)
  }
}

/** The names a declaration binds as parameters, in order; "" for an unnamed one. */
function parameterOrder(decl: Decl): string[] {
  const out: string[] = []
  for (const p of decl.node.childForFieldName("parameters")?.namedChildren ?? []) {
    if (p.type !== "parameter_declaration" && p.type !== "variadic_parameter_declaration") continue
    const names = p.namedChildren.filter((c) => c.type === "identifier")
    if (names.length === 0) out.push("")
    for (const n of names) out.push(n.text)
  }
  return out
}

/** Methods that store a parameter in a field of their receiver: `func (g *Gate) SetBlock(f func()) { g.block = f }`. */
function findSetters(facts: FileFacts[]): { byRecv: Map<string, Setter[]>; byName: Map<string, Setter[]> } {
  const byRecv = new Map<string, Setter[]>()
  const byName = new Map<string, Setter[]>()
  for (const ff of facts) {
    for (const d of ff.decls) {
      if (!d.recv || !d.recvVar) continue
      const params = parameterOrder(d)
      for (const n of walk(d.node)) {
        if (n.type !== "assignment_statement") continue
        const left = n.childForFieldName("left")?.namedChildren[0]
        const right = n.childForFieldName("right")?.namedChildren[0]
        if (left?.type !== "selector_expression" || right?.type !== "identifier") continue
        if (left.childForFieldName("operand")?.text !== d.recvVar) continue
        const field = left.childForFieldName("field")?.text
        const index = params.indexOf(right.text)
        if (!field || index < 0) continue
        const setter: Setter = { recv: d.recv, field, index }
        addTo(byRecv, `${d.recv}.${d.name}`, setter)
        addTo(byName, d.name, setter)
      }
    }
  }
  return { byRecv, byName }
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

interface CallbackLiteral {
  field: string
  /** The struct type of the composite literal the func was stored in; null for an `x.F = func...` assignment. */
  owner: string | null
  literal: SyntaxNode
}

/** The func literals a declaration stores in a struct field: `x.Field = func...` and `T{Field: func...}`. */
function callbackLiterals(decl: Decl): Map<string, CallbackLiteral> {
  const out = new Map<string, CallbackLiteral>()
  for (const n of walk(decl.node)) {
    if (n.type === "assignment_statement") {
      const left = n.childForFieldName("left")?.namedChildren[0]
      const right = n.childForFieldName("right")?.namedChildren[0]
      if (left?.type !== "selector_expression" || right?.type !== "func_literal") continue
      const field = left.childForFieldName("field")?.text
      if (field) out.set(nodeKey(right), { field, owner: null, literal: right })
    } else if (n.type === "composite_literal") {
      const typeNode = n.childForFieldName("type")
      const owner = typeNode ? bareTypeName(typeNode) : null
      if (!owner) continue
      for (const el of n.childForFieldName("body")?.namedChildren ?? []) {
        if (el.type !== "keyed_element") continue
        const [key, value] = el.namedChildren
        const field = key?.namedChildren[0]
        const literal = value?.namedChildren[0]
        if (field?.type === "identifier" && literal?.type === "func_literal") out.set(nodeKey(literal), { field: field.text, owner, literal })
      }
    }
  }
  return out
}

const NO_FLAGS: BodyFlags = { opensTransaction: false, mutatesState: false, compensates: false, takesTx: false, takesRequest: false, arity: null }

function makeDef(file: string, key: string, name: string, recv: string | null, node: SyntaxNode, flags = NO_FLAGS): FuncDef {
  return { id: `${file}:${key}`, key, name, recv, file, dir: dirOf(file), line: node.startPosition.row + 1, ...flags }
}

function buildIndex(facts: FileFacts[]): { index: Index; defs: Map<string, FuncDef>; callbackOwners: Map<string, FuncDef> } {
  const index: Index = { methodsByName: new Map(), methodsByRecv: new Map(), funcsByDir: new Map(), callbacksByField: new Map(), callbacksUnowned: new Map(), callbacksByTypeField: new Map(), settersByRecv: new Map(), settersByName: new Map(), returns: new Map() }
  const defs = new Map<string, FuncDef>()
  const callbackOwners = new Map<string, FuncDef>() // `${file}:${literal nodeKey}` -> callback def
  for (const ff of facts) {
    for (const d of ff.decls) {
      const def = makeDef(d.file, d.recv ? `${d.recv}.${d.name}` : d.name, d.name, d.recv, d.node, bodyFlags(d))
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
        const cbDef = makeDef(d.file, `callback:${cb.owner ? `${cb.owner}.` : ""}${cb.field}`, cb.field, null, cb.literal)
        defs.set(cbDef.id, cbDef)
        storeFunctions(index, cb.owner, cb.field, [cbDef])
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
  /** Every field name a struct type declares. */
  fieldNames: FieldNames
  packageVars: PackageVars
  /** Interface name to the concrete types that have all of its methods with the same signatures. */
  implementers: Map<string, string[]>
  index: Index
  /** Element types of slice and map variables. */
  localElems: Map<string, string>
  /** Variables declared inside the function, typed where the right-hand side makes the type clear. */
  locals: Map<string, string>
}

/** A package-level variable of the function's own package, by name. */
function packageVarOf(r: Resolver, name: string, kind: "types" | "elems"): string | null {
  return r.packageVars.get(dirOf(r.ff.file))?.[kind].get(name) ?? null
}

/** The type a selector operand has, when it can be read from the receiver, a typed parameter, or a struct field. */
function operandType(operand: SyntaxNode, r: Resolver): string | null {
  const typeOfIdent = (name: string): string | null =>
    r.locals.get(name) ?? (name === r.decl.recvVar ? r.decl.recv : (r.decl.params.get(name) ?? packageVarOf(r, name, "types")))
  if (operand.type === "identifier") return typeOfIdent(operand.text)
  // a value built in place: `(&T{...}).Method()`, `(T{...}).Method()`
  if (operand.type === "parenthesized_expression" || operand.type === "unary_expression" || operand.type === "composite_literal") return inferType(operand, r)
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
    case "parenthesized_expression":
      return expr.namedChildren[0] ? inferType(expr.namedChildren[0], r) : null
    case "composite_literal": {
      const type = expr.childForFieldName("type")
      return type ? bareTypeName(type) : null
    }
    case "identifier":
      return r.locals.get(expr.text) ?? (expr.text === r.decl.recvVar ? r.decl.recv : (r.decl.params.get(expr.text) ?? packageVarOf(r, expr.text, "types")))
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
      return r.localElems.get(expr.text) ?? r.decl.paramElems.get(expr.text) ?? packageVarOf(r, expr.text, "elems")
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
    } else if (n.type === "func_literal") {
      // the parameters of a closure: `func(tx *gorm.DB) error { ... }`
      for (const p of n.childForFieldName("parameters")?.namedChildren ?? []) {
        if (p.type !== "parameter_declaration") continue
        const type = p.childForFieldName("type")
        const bare = type ? bareTypeName(type) : null
        if (!bare) continue
        for (const id of p.namedChildren) if (id.type === "identifier" && !r.decl.params.has(id.text)) r.locals.set(id.text, bare)
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
    const implemented = (r.implementers.get(type) ?? []).flatMap((t) => r.index.methodsByRecv.get(`${t}.${name}`) ?? [])
    if (implemented.length > 0) return { targets: implemented, via: "call" }
    // The receiver's type is known: use what was stored in this type's field, or stored where the owner is unknown,
    // never what another type stored in a field of the same name.
    const callbacks = r.index.callbacksByTypeField.get(`${type}.${name}`) ?? r.index.callbacksUnowned.get(name) ?? []
    if (callbacks.length > 0) return { targets: callbacks, via: "callback" }
    // A field of that name holds a func value: the call goes to whatever was stored in it, not to a method elsewhere.
    if (r.fieldNames.get(type)?.has(name)) return { targets: [], via: "call" }
  }
  const unique = uniqueMethod(name, r)
  if (unique.length > 0) return { targets: unique, via: "call" }
  return { targets: r.index.callbacksByField.get(name) ?? [], via: "callback" }
}

/** Whether two syntax nodes are the same piece of source: tree-sitter does not keep one object per node, so `===` is unreliable. */
const sameNode = (a: SyntaxNode | null | undefined, b: SyntaxNode): boolean => !!a && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type

/** True for the places where a function or method used as a value is handed on: an argument, a keyed field, a return, an assignment. */
function isHandedOn(node: SyntaxNode): boolean {
  const parent = node.parent
  if (!parent) return false
  if (parent.type === "argument_list") return true
  if (parent.type === "literal_element") return parent.parent?.type === "keyed_element" && sameNode(parent.parent.namedChildren[1], parent)
  if (parent.type === "return_statement") return true
  if (parent.type !== "expression_list") return false
  const owner = parent.parent
  if (owner?.type === "return_statement") return true
  return (owner?.type === "assignment_statement" || owner?.type === "short_var_declaration") && sameNode(owner.childForFieldName("right"), parent)
}

/** Every name the declaration binds as a parameter, whatever its type. */
function parameterNames(decl: Decl): Set<string> {
  const names = new Set<string>()
  for (const list of [decl.node.childForFieldName("parameters"), decl.node.childForFieldName("receiver")]) {
    for (const p of list?.namedChildren ?? []) for (const id of p.namedChildren) if (id.type === "identifier") names.add(id.text)
  }
  return names
}

/**
 * The function or method a selector or identifier names when it is used as a value (`h.respond(h.fs.Accept)`,
 * `return s.hub.In`, `run(worker)`), or none. Only exact matches count: a method needs a known receiver type.
 */
function resolveReference(node: SyntaxNode, r: Resolver, params: Set<string>): FuncDef[] {
  if (!isHandedOn(node)) return []
  if (node.type === "identifier") {
    const name = node.text
    if (params.has(name) || r.locals.has(name) || r.localElems.has(name)) return []
    return r.index.funcsByDir.get(`${dirOf(r.ff.file)}${name}`) ?? []
  }
  const operand = node.childForFieldName("operand")
  const name = node.childForFieldName("field")?.text
  if (!operand || !name) return []
  if (operand.type === "identifier" && isPackageName(operand, r)) {
    return packageFuncKeys(r, r.ff.imports.get(operand.text)!, name).flatMap((k) => r.index.funcsByDir.get(k) ?? [])
  }
  const type = operandType(operand, r)
  return type ? (r.index.methodsByRecv.get(`${type}.${name}`) ?? []) : []
}

/** `f[T](...)` and `pkg.F[T](...)` call the function the indexed expression names: look through the type arguments. */
function unwrapInstantiation(fn: SyntaxNode | null): SyntaxNode | null {
  if (fn?.type !== "index_expression") return fn
  const operand = fn.childForFieldName("operand")
  return operand?.type === "identifier" || operand?.type === "selector_expression" ? operand : fn
}

/**
 * `f[T](x)` with a single argument parses as a conversion to the generic type `f[T]`. It is a call when `f` (or
 * `pkg.F`) is a function; a real conversion names a type, which is never a function.
 */
function resolveGenericConversion(node: SyntaxNode, r: Resolver): FuncDef[] {
  const generic = node.childForFieldName("type")
  if (generic?.type !== "generic_type") return []
  const name = generic.namedChildren[0]
  if (name?.type === "type_identifier") return r.index.funcsByDir.get(`${dirOf(r.ff.file)}${name.text}`) ?? []
  if (name?.type !== "qualified_type") return []
  const pkg = name.namedChildren[0]?.text
  const fn = name.namedChildren[1]?.text
  const path = pkg ? r.ff.imports.get(pkg) : undefined
  return path && fn ? packageFuncKeys(r, path, fn).flatMap((k) => r.index.funcsByDir.get(k) ?? []) : []
}

/** What a node reaches: a written call, a generic call with one argument, or a function used as a value. */
function resolveNode(node: SyntaxNode, r: Resolver, params: Set<string>): { targets: FuncDef[]; via: EdgeVia } {
  if (node.type === "call_expression") return resolveCall(node, r)
  if (node.type === "type_conversion_expression") return { targets: resolveGenericConversion(node, r), via: "call" }
  return { targets: resolveReference(node, r, params), via: "ref" }
}

function resolveCall(call: SyntaxNode, r: Resolver): { targets: FuncDef[]; via: EdgeVia } {
  const fn = unwrapInstantiation(call.childForFieldName("function"))
  if (!fn) return { targets: [], via: "call" }
  if (fn.type === "identifier") {
    const dir = dirOf(r.ff.file)
    return { targets: r.index.funcsByDir.get(`${dir}${fn.text}`) ?? [], via: "call" }
  }
  if (fn.type === "selector_expression") return resolveSelector(fn, r)
  return { targets: [], via: "call" }
}

/** For each interface with methods, the receiver types that declare every one of them with the same signature. */
function findImplementers(interfaces: Interfaces, facts: FileFacts[]): Map<string, string[]> {
  const signatures = new Map<string, Set<string>>() // `${recv}.${method}` -> signatures declared
  const receivers = new Set<string>()
  for (const ff of facts) {
    for (const d of ff.decls) {
      if (!d.recv) continue
      receivers.add(d.recv)
      const key = `${d.recv}.${d.name}`
      signatures.set(key, (signatures.get(key) ?? new Set()).add(d.signature))
    }
  }
  const out = new Map<string, string[]>()
  for (const [iface, methods] of interfaces) {
    if (methods.size === 0) continue
    const types = [...receivers].filter((t) => [...methods].every(([m, sig]) => signatures.get(`${t}.${m}`)?.has(sig)))
    if (types.length > 0) out.set(iface, types)
  }
  return out
}

/** The setters of one type that a call on an untyped receiver can mean, or none when the name belongs to several types. */
function setterCandidates(index: Index, recvType: string | null, name: string): Setter[] {
  if (recvType) return index.settersByRecv.get(`${recvType}.${name}`) ?? []
  const byName = index.settersByName.get(name) ?? []
  return byName.every((x) => x.recv === byName[0].recv) ? byName : []
}

/**
 * Finds where a function is put into a field so that a later call through the field reaches it: an argument given to a
 * setter, the right-hand side of `x.F = f`, or a value in `T{F: f}`. Func literals become callback functions of their own.
 */
function registerStoredFunctions(r: Resolver, params: Set<string>, defs: Map<string, FuncDef>, callbackOwners: Map<string, FuncDef>): void {
  const { index, decl } = r
  for (const n of walk(decl.node)) {
    if (n.type === "call_expression") {
      const fn = unwrapInstantiation(n.childForFieldName("function"))
      const operand = fn?.type === "selector_expression" ? fn.childForFieldName("operand") : null
      const name = fn?.type === "selector_expression" ? fn.childForFieldName("field")?.text : null
      if (!operand || !name) continue
      for (const setter of setterCandidates(index, operandType(operand, r), name)) {
        const arg = n.childForFieldName("arguments")?.namedChildren[setter.index]
        if (!arg) continue
        if (arg.type === "func_literal") {
          const cb = makeDef(decl.file, `callback:${setter.recv}.${setter.field}`, setter.field, null, arg)
          defs.set(cb.id, cb)
          callbackOwners.set(`${decl.file}:${nodeKey(arg)}`, cb)
          storeFunctions(index, setter.recv, setter.field, [cb])
        } else {
          storeFunctions(index, setter.recv, setter.field, resolveReference(arg, r, params))
        }
      }
    } else if (n.type === "assignment_statement") {
      const left = n.childForFieldName("left")?.namedChildren[0]
      const right = n.childForFieldName("right")?.namedChildren[0]
      if (left?.type !== "selector_expression" || !right || right.type === "func_literal") continue
      const field = left.childForFieldName("field")?.text
      const operand = left.childForFieldName("operand")
      if (field) storeFunctions(index, operand ? operandType(operand, r) : null, field, resolveReference(right, r, params))
    } else if (n.type === "composite_literal") {
      const typeNode = n.childForFieldName("type")
      const owner = typeNode ? bareTypeName(typeNode) : null
      if (!owner) continue
      for (const el of n.childForFieldName("body")?.namedChildren ?? []) {
        if (el.type !== "keyed_element") continue
        const [key, value] = el.namedChildren
        const field = key?.namedChildren[0]
        const target = value?.namedChildren[0]
        if (field?.type === "identifier" && target && target.type !== "func_literal") storeFunctions(index, owner, field.text, resolveReference(target, r, params))
      }
    }
  }
}

/** The method name of a `x.Name(...)` call that may be a project method the graph missed: the receiver's type is unknown or an interface. */
function unresolvedSite(call: SyntaxNode, r: Resolver, interfaces: Interfaces, projectTypes: Set<string>): { name: string } | null {
  const fn = unwrapInstantiation(call.childForFieldName("function"))
  if (fn?.type !== "selector_expression") return null
  const operand = fn.childForFieldName("operand")
  const name = fn.childForFieldName("field")?.text
  if (!operand || !name || !r.index.methodsByName.has(name)) return null
  if (operand.type === "identifier" && isPackageName(operand, r)) return null
  const type = operandType(operand, r)
  if (type !== null) return interfaces.has(type) ? { name } : null
  // A chain such as `s.db.WithContext(ctx).Create(...)`: its root decides. A root of a type from outside the project is not a project call.
  let root: SyntaxNode | null = operand
  while (root?.type === "call_expression") {
    const callee: SyntaxNode | null = root.childForFieldName("function")
    root = callee?.type === "selector_expression" ? callee.childForFieldName("operand") : null
  }
  const rootType = root ? operandType(root, r) : null
  return rootType === null || projectTypes.has(rootType) || interfaces.has(rootType) ? { name } : null
}

export function buildCallGraph(files: GoFile[]): CallGraph {
  const { facts, fieldTypes, fieldElems, fieldNames, packageVars, interfaces } = collectFacts(files)
  const { index, defs, callbackOwners } = buildIndex(facts)
  const setters = findSetters(facts)
  index.settersByRecv = setters.byRecv
  index.settersByName = setters.byName
  const implementers = findImplementers(interfaces, facts)
  const from = new Map<string, CallEdge[]>()
  const to = new Map<string, CallEdge[]>()
  const unresolved = new Map<string, UnresolvedCall[]>()
  const projectTypes = new Set(facts.flatMap((ff) => ff.decls.flatMap((d) => (d.recv ? [d.recv] : []))))
  const owners = new Map(facts.flatMap((ff) => ff.decls.map((d) => [`${d.file}:${d.node.startIndex}`, d] as const)))
  void owners

  // Pass 1: type every function's locals and record the functions stored in fields, before any call through a field is resolved.
  const resolvers: { resolver: Resolver; params: Set<string>; ownerId: string }[] = []
  for (const ff of facts) {
    for (const decl of ff.decls) {
      const ownerId = `${decl.file}:${decl.recv ? `${decl.recv}.${decl.name}` : decl.name}`
      const resolver: Resolver = { ff, decl, fieldTypes, fieldElems, fieldNames, packageVars, implementers, index, locals: new Map(), localElems: new Map() }
      inferLocals(resolver)
      const params = parameterNames(decl)
      registerStoredFunctions(resolver, params, defs, callbackOwners)
      resolvers.push({ resolver, params, ownerId })
    }
  }

  // Pass 2: the edges.
  for (const { resolver, params, ownerId } of resolvers) {
    const decl = resolver.decl
    for (const call of walk(decl.node)) {
      if (!["call_expression", "type_conversion_expression", "selector_expression", "identifier"].includes(call.type)) continue
      const edgeOwner = enclosingCallback(call, decl, callbackOwners) ?? ownerId
      const { targets, via } = resolveNode(call, resolver, params)
      const kind: EdgeVia = call.parent?.type === "go_statement" ? "go" : via
      if (targets.length === 0 && call.type === "call_expression" && !decl.file.endsWith("_test.go")) {
        const site = unresolvedSite(call, resolver, interfaces, projectTypes)
        if (site) addTo(unresolved, site.name, { ...site, file: decl.file, line: call.startPosition.row + 1, caller: defs.get(edgeOwner)?.key ?? edgeOwner, args: call.childForFieldName("arguments")?.namedChildren.length ?? 0 })
      }
      for (const t of targets) {
        if (t.id === edgeOwner) continue
        const edge: CallEdge = { from: edgeOwner, to: t.id, line: call.startPosition.row + 1, inTxn: isInTransaction(call), via: kind }
        addTo(from, edge.from, edge)
        addTo(to, edge.to, edge)
      }
    }
  }

  return {
    defs,
    unresolvedCalls: (name) => unresolved.get(name) ?? [],
    edgesFrom: (id) => from.get(id) ?? [],
    edgesTo: (id) => to.get(id) ?? [],
    typeHasMutex: (type) => [...(fieldTypes.get(type)?.values() ?? [])].some((t) => t === "Mutex" || t === "RWMutex"),
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

import { walk, bareTypeName, callParts, functionParamTypes, receiverTypeName, type SyntaxNode } from "./ast.js"
import type { HandlerMethod } from "./handler-parser.js"

/**
 * Project-wide facts tenant isolation needs to follow a request past the
 * handler: the type of a package-level variable (`var GroupApp = new(ServiceGroup)`),
 * the type a constructor returns (`func NewSysRoleList() SysRoleList`), which
 * file declares a struct (to tell a DAO or model from a service), and the GORM
 * callbacks a project registers (`db.Callback().Create().Before(...).Register(name, fn)`).
 */
export interface CodeIndex {
  /** Package-level variable → bare type name. */
  packageVars:  Map<string, string>
  /** Function name → bare type of its (first) result. */
  returnTypes:  Map<string, string>
  /** Struct / named type → path of the file that declares it. */
  typeFiles:    Map<string, string>
  /** Function declarations by name, for callbacks registered by name. */
  functions:    Map<string, SyntaxNode>
  /** GORM callbacks by operation ("create" | "update" | "delete" | "query") → registered function names. */
  callbacks:    Map<string, string[]>
  /** A named slice or pointer type → its element type: `type SysRoleList []SysRole` → SysRole. */
  elementTypes: Map<string, string>
  /** A struct → the types it embeds: `type User struct { BaseModel; ... }` → [BaseModel]. */
  embeddedTypes: Map<string, string[]>
  /**
   * A struct name → the named fields of every struct declared with that name
   * (packages reuse names: service.Board and model.Board).
   */
  structFields: Map<string, string[]>
}

export function buildCodeIndex(files: { path: string; root: SyntaxNode }[]): CodeIndex {
  const index: CodeIndex = {
    packageVars: new Map(), returnTypes: new Map(), typeFiles: new Map(), functions: new Map(), callbacks: new Map(),
    elementTypes: new Map(), embeddedTypes: new Map(), structFields: new Map(),
  }
  for (const file of files) {
    for (const top of file.root.namedChildren) {
      if (top.type === "var_declaration") {
        for (const spec of top.descendantsOfType("var_spec")) {
          const type = varSpecType(spec, index)
          if (!type) continue
          for (const name of spec.childrenForFieldName("name")) {
            if (name.type === "identifier" && !index.packageVars.has(name.text)) index.packageVars.set(name.text, type)
          }
        }
      } else if (top.type === "type_declaration") {
        for (const spec of top.descendantsOfType("type_spec")) {
          const name = spec.childForFieldName("name")?.text
          if (name && !index.typeFiles.has(name)) index.typeFiles.set(name, file.path)
          const typeNode = spec.childForFieldName("type")
          if (name && typeNode?.type === "slice_type") {
            const element = typeNode.childForFieldName("element")
            const bare = element ? bareTypeName(element) : null
            if (bare) index.elementTypes.set(name, bare)
          }
          if (name && typeNode?.type === "struct_type") {
            const embedded: string[] = []
            const named: string[] = []
            // only this struct's own fields (not those of a nested anonymous struct)
            const list = typeNode.namedChildren.find((c) => c.type === "field_declaration_list")
            for (const field of list?.namedChildren ?? []) {
              if (field.type !== "field_declaration") continue
              const names = field.childrenForFieldName("name")
              if (names.length > 0) { named.push(...names.map((n) => n.text)); continue }
              const t = field.childForFieldName("type")
              const bare = t ? bareTypeName(t) : null
              if (bare) embedded.push(bare)
            }
            if (embedded.length) index.embeddedTypes.set(name, [...(index.embeddedTypes.get(name) ?? []), ...embedded])
            index.structFields.set(name, [...(index.structFields.get(name) ?? []), ...named])
          }
        }
      } else if (top.type === "function_declaration") {
        const name = top.childForFieldName("name")?.text
        if (!name) continue
        if (!index.functions.has(name)) index.functions.set(name, top)
        const result = top.childForFieldName("result")
        const type = result ? resultType(result) : null
        if (type && !index.returnTypes.has(name)) index.returnTypes.set(name, type)
      }
    }
    // db.Callback().Create().Before("gorm:create").Register("name", CreateHook)
    for (const node of walk(file.root)) {
      const parts = callParts(node)
      if (!parts || parts.method !== "Register" || !parts.receiver?.includes("Callback()")) continue
      const op = /Callback\(\)\.(Create|Update|Delete|Query)\(\)/.exec(parts.receiver)?.[1]?.toLowerCase()
      const fn = parts.args[1]?.text.split(".").pop()
      if (op && fn) index.callbacks.set(op, [...(index.callbacks.get(op) ?? []), fn])
    }
  }
  return index
}

/** The type a `var x T` / `var x = new(T)` / `var x = &T{}` / `var x = NewT()` declares. */
function varSpecType(spec: SyntaxNode, index: CodeIndex): string | null {
  const typeNode = spec.childForFieldName("type")
  if (typeNode) return bareTypeName(typeNode)
  const value = spec.childForFieldName("value")?.namedChildren[0]
  return value ? typeOfValueText(value.text, index) : null
}

function resultType(result: SyntaxNode): string | null {
  if (result.type === "parameter_list") {
    const first = result.namedChildren.find((c) => c.type === "parameter_declaration")
    const t = first?.childForFieldName("type")
    return t ? bareTypeName(t) : null
  }
  return bareTypeName(result)
}

/** `&dal.BoardQuery{}` / `models.SysRole{}` / `new(Board)` / `models.NewSysRoleList()` → the bare type. */
export function typeOfValueText(text: string, index: CodeIndex): string | null {
  const t = text.trim()
  const literal = /^&?(?:\w+\.)?([A-Z]\w*)\s*\{/.exec(t)
  if (literal) return literal[1]
  const made = /^new\(\s*\*?(?:\w+\.)?(\w+)\s*\)$/.exec(t)
  if (made) return made[1]
  const call = /^(?:\w+\.)?(\w+)\s*\(/.exec(t)
  if (call) return index.returnTypes.get(call[1]) ?? null
  return null
}

/** Paths and type names that hold data access rather than business logic. */
const DATA_PATH = /(^|\/)(dal|dao|daos|repositor\w*|repo|repos|store|stores|query|queries|models?|entit\w*|persistence|db)(\/|\.go$)/i
const DATA_TYPE = /(Query|Repo|Repository|Dao|DAO|Store|Model|Mapper)$/

/**
 * Whether rows of a model carry a tenant: its struct (or, for a named slice
 * like `type SysRoleList []SysRole`, its element's struct) has a field named for
 * the tenant. A table without one (menus, the tenants table itself) is shared,
 * so a query on it has no tenant to miss. A model whose struct is not in the
 * project (or "gorm" when no model is named) → true: it is still reported.
 */
export function modelHasTenantField(
  model: string,
  index: CodeIndex,
  signalMatch: (text: string) => boolean,
): boolean {
  // a DAO is judged by the entity it serves: UserQuery / UserRepository → User
  const entity = model.replace(/(Query|Repo|Repository|Dao|DAO|Store|Mapper)$/, "")
  if (entity !== model) model = entity
  const element = index.elementTypes.get(model)
  const candidates = [model, element].filter((t): t is string => !!t)
  if (!candidates.some((t) => index.typeFiles.has(t))) return true
  // one level of embedded structs: type User struct { BaseModel; ... } with TenantID in BaseModel
  for (const t of [...candidates]) candidates.push(...(index.embeddedTypes.get(t) ?? []))
  return candidates.some((t) => (index.structFields.get(t) ?? []).some((field) => signalMatch(field)))
}

export function isDataType(typeName: string, index: CodeIndex): boolean {
  const file = index.typeFiles.get(typeName)
  return (!!file && DATA_PATH.test(file)) || DATA_TYPE.test(typeName)
}

/**
 * The bare type of a receiver expression as written at a call site in `method`:
 * the method's receiver (`s`), a field chain (`s.repo`), a parameter or local
 * (`db := dal.BoardQuery{}`, `list := models.NewSysRoleList()`), or a
 * package-level variable, possibly behind an import alias (`service.GroupApp.Board`).
 * Null when any step does not resolve (or the expression contains a call).
 */
export function resolveReceiverType(
  method: HandlerMethod,
  receiver: string,
  fieldTypesOf: (typeName: string) => Map<string, string>,
  index: CodeIndex,
): string | null {
  if (receiver.includes("(") || receiver.includes("[")) return null
  const segments = receiver.split(".")
  let type: string | null = null
  let rest = segments

  const recvName = receiverNameOf(method.node)
  if (segments[0] === recvName) {
    type = receiverTypeName(method.node)
    rest = segments.slice(1)
  } else {
    const local = localType(method.node, segments[0], index)
    if (local) {
      type = local
      rest = segments.slice(1)
    } else if (index.packageVars.has(segments[0])) {
      type = index.packageVars.get(segments[0])!
      rest = segments.slice(1)
    } else if (segments.length > 1 && index.packageVars.has(segments[1])) {
      type = index.packageVars.get(segments[1])!   // pkg.Var
      rest = segments.slice(2)
    }
  }
  for (const field of rest) {
    if (!type) return null
    type = fieldType(type, field, fieldTypesOf, index)
  }
  return type
}

/**
 * The type of `field` on a struct: a named field, an embedded struct (its field
 * name is its type name: `type Controller struct { BoardApi }`), or a field
 * promoted from an embedded struct, one level deep.
 */
function fieldType(
  typeName: string,
  field: string,
  fieldTypesOf: (typeName: string) => Map<string, string>,
  index: CodeIndex,
): string | null {
  const named = fieldTypesOf(typeName).get(field)
  if (named) return named
  const embedded = index.embeddedTypes.get(typeName) ?? []
  if (embedded.includes(field)) return field
  for (const e of embedded) {
    const promoted = fieldTypesOf(e).get(field) ?? ((index.embeddedTypes.get(e) ?? []).includes(field) ? field : undefined)
    if (promoted) return promoted
  }
  return null
}

function receiverNameOf(fn: SyntaxNode): string | null {
  const decl = fn.childForFieldName("receiver")?.namedChildren.find((c) => c.type === "parameter_declaration")
  return decl?.namedChildren.find((c) => c.type === "identifier")?.text ?? null
}

/** The type of a parameter or a local declared in a function body. */
function localType(fn: SyntaxNode, name: string, index: CodeIndex): string | null {
  const param = functionParamTypes(fn).get(name)
  if (param) return param
  const body = fn.childForFieldName("body")
  if (!body) return null
  for (const n of walk(body)) {
    if (n.type === "var_spec") {
      if (!n.childrenForFieldName("name").some((id) => id.text === name)) continue
      const t = varSpecType(n, index)
      if (t) return t
    } else if (n.type === "short_var_declaration" || n.type === "assignment_statement") {
      const left = n.childForFieldName("left")?.namedChildren ?? []
      const right = n.childForFieldName("right")?.namedChildren ?? []
      const i = left.findIndex((l) => l.text === name)
      if (i < 0 || !right[i]) continue
      const t = typeOfValueText(right[i].text, index)
      if (t) return t
    }
  }
  return null
}

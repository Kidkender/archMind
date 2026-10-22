import {
  parseGo,
  walk,
  receiverTypeName,
  bareTypeName,
  functionParamTypes,
  type SyntaxNode,
} from "@kidkender/archmind-go-parser"

export interface GoFile {
  path: string
  content: string
}

/** One function or method declaration, with what call resolution needs to know about it. */
/** The element type of a slice, array or map type (through pointers): `[]*Rect` and `map[string]Rect` both give "Rect". */
export function elementTypeName(typeNode: SyntaxNode): string | null {
  let n: SyntaxNode | null = typeNode
  while (n && n.type === "pointer_type") n = n.namedChildren[0] ?? null
  if (!n) return null
  if (n.type === "slice_type" || n.type === "array_type") {
    const el = n.childForFieldName("element")
    return el ? bareTypeName(el) : null
  }
  if (n.type === "map_type") {
    const el = n.childForFieldName("value")
    return el ? bareTypeName(el) : null
  }
  return null
}

export interface Decl {
  file: string
  name: string
  recv: string | null
  /** The receiver variable, e.g. "s" in `func (s *Service) Run()`. */
  recvVar: string | null
  params: Map<string, string>
  /** Parameter name to the element type of its slice or map type. */
  paramElems: Map<string, string>
  /** Bare type of the first declared result, e.g. "Svc" for `func New() (*Svc, error)`. */
  returns: string | null
  node: SyntaxNode
}

export interface FileFacts {
  file: string
  /** Import alias or last path element -> last path element of the import path. */
  imports: Map<string, string>
  decls: Decl[]
}

export type FieldTypes = Map<string, Map<string, string>>
/** Type name, field name to the element type of that field's slice or map type. */
export type FieldElems = Map<string, Map<string, string>>

function receiverVar(fn: SyntaxNode): string | null {
  const decl = fn.childForFieldName("receiver")?.namedChildren.find((c) => c.type === "parameter_declaration")
  return decl?.namedChildren.find((c) => c.type === "identifier")?.text ?? null
}

function returnTypeOf(fn: SyntaxNode): string | null {
  const result = fn.childForFieldName("result")
  if (!result) return null
  if (result.type !== "parameter_list") return bareTypeName(result)
  const first = result.namedChildren.find((c) => c.type === "parameter_declaration")
  const type = first?.childForFieldName("type")
  return type ? bareTypeName(type) : null
}

function importsOf(root: SyntaxNode): Map<string, string> {
  const out = new Map<string, string>()
  for (const spec of walk(root)) {
    if (spec.type !== "import_spec") continue
    const raw = spec.childForFieldName("path")?.text.replace(/^["`]|["`]$/g, "")
    if (!raw) continue
    const last = raw.slice(raw.lastIndexOf("/") + 1)
    const alias = spec.childForFieldName("name")?.text
    out.set(alias && alias !== "_" && alias !== "." ? alias : last, last)
  }
  return out
}

function paramElementTypes(fn: SyntaxNode): Map<string, string> {
  const out = new Map<string, string>()
  const params = fn.childForFieldName("parameters")
  for (const p of params?.namedChildren ?? []) {
    if (p.type !== "parameter_declaration") continue
    const typeNode = p.childForFieldName("type")
    const el = typeNode ? elementTypeName(typeNode) : null
    if (el) for (const id of p.namedChildren) if (id.type === "identifier") out.set(id.text, el)
  }
  return out
}

function recordStructFields(typeSpec: SyntaxNode, into: FieldTypes, elems: FieldElems): void {
  const name = typeSpec.childForFieldName("name")?.text
  const body = typeSpec.childForFieldName("type")
  if (!name || body?.type !== "struct_type") return
  const fields = into.get(name) ?? new Map<string, string>()
  const elemFields = elems.get(name) ?? new Map<string, string>()
  into.set(name, fields)
  elems.set(name, elemFields)
  for (const decl of walk(body)) {
    if (decl.type !== "field_declaration") continue
    const typeNode = decl.childForFieldName("type")
    if (!typeNode) continue
    const bare = bareTypeName(typeNode)
    const el = elementTypeName(typeNode)
    const names = decl.namedChildren.filter((c) => c.type === "field_identifier")
    if (bare && names.length === 0) fields.set(bare, bare) // embedded field: reachable under its type's name
    for (const id of names) {
      if (bare) fields.set(id.text, bare)
      if (el) elemFields.set(id.text, el)
    }
  }
}

/** Parses every file once and collects declarations, imports and struct field types. */
export function collectFacts(files: GoFile[]): { facts: FileFacts[]; fieldTypes: FieldTypes; fieldElems: FieldElems } {
  const facts: FileFacts[] = []
  const fieldTypes: FieldTypes = new Map()
  const fieldElems: FieldElems = new Map()
  for (const f of files) {
    const root = parseGo(f.content)
    const decls: Decl[] = []
    for (const n of walk(root)) {
      if (n.type === "type_spec") recordStructFields(n, fieldTypes, fieldElems)
      if (n.type !== "function_declaration" && n.type !== "method_declaration") continue
      const name = n.childForFieldName("name")?.text
      if (!name) continue
      decls.push({
        file: f.path,
        name,
        recv: n.type === "method_declaration" ? receiverTypeName(n) : null,
        recvVar: n.type === "method_declaration" ? receiverVar(n) : null,
        params: functionParamTypes(n),
        paramElems: paramElementTypes(n),
        returns: returnTypeOf(n),
        node: n,
      })
    }
    facts.push({ file: f.path, imports: importsOf(root), decls })
  }
  return { facts, fieldTypes, fieldElems }
}

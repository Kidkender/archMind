import { walk, bareTypeName } from "./ast.js"
import type { SyntaxNode } from "./ast.js"

export interface BoundField {
  name: string
  bindingTag: string | null
}

/** Every struct declared in a file by name, first declaration winning; built once per syntax tree because each route looks structs up again. */
const structIndexes = new WeakMap<SyntaxNode, Map<string, SyntaxNode>>()

function structNodes(root: SyntaxNode): Map<string, SyntaxNode> {
  const cached = structIndexes.get(root)
  if (cached) return cached
  const index = new Map<string, SyntaxNode>()
  for (const node of walk(root)) {
    if (node.type !== "type_spec") continue
    const name = node.childForFieldName("name")?.text
    const typeNode = node.childForFieldName("type")
    if (name && typeNode?.type === "struct_type" && !index.has(name)) index.set(name, typeNode)
  }
  structIndexes.set(root, index)
  return index
}

/**
 * Finds `type <name> struct { ... }` in `root` and returns each field's name
 * plus its `binding:"..."` struct-tag value (null when the field has no
 * `binding` tag). This is the Go equivalent of parsing a Laravel FormRequest's
 * `rules()` array — same "validation_gate" IR concept, different mechanism.
 */
export function findStructFields(root: SyntaxNode, typeName: string): BoundField[] | null {
  const typeNode = structNodes(root).get(typeName)
  if (!typeNode) return null

  const fieldList = typeNode.namedChildren.find((c) => c.type === "field_declaration_list")
  if (!fieldList) return []

  return fieldList.namedChildren
    .filter((f) => f.type === "field_declaration")
    .map((f) => {
      const name = f.childForFieldName("name")?.text ?? ""
      const tagNode = f.childForFieldName("tag")
      const tagText = tagNode ? tagNode.text.replace(/^`|`$/g, "") : ""
      const bindingMatch = tagText.match(/binding:"([^"]*)"/)
      return { name, bindingTag: bindingMatch ? bindingMatch[1] : null }
    })
}

/**
 * Finds `type <name> struct { ... }` and returns field name → bare declared
 * type (e.g. "orderService" → "OrderService"), for resolving a
 * handler's `h.someService.Method(...)` call to the service type that
 * declares Method — one hop of receiver resolution beyond the handler
 * itself, needed because real Gin projects typically put GORM transactions
 * in the service layer, not directly in the handler. Returns null when
 * `typeName` isn't a struct in `root`.
 */
export function findStructFieldTypes(root: SyntaxNode, typeName: string): Map<string, string> | null {
  const typeNode = structNodes(root).get(typeName)
  if (!typeNode) return null

  const fieldList = typeNode.namedChildren.find((c) => c.type === "field_declaration_list")
  const map = new Map<string, string>()
  if (!fieldList) return map

  for (const f of fieldList.namedChildren) {
    if (f.type !== "field_declaration") continue
    const name = f.childForFieldName("name")?.text
    const fieldType = f.childForFieldName("type")
    const bare = fieldType ? bareTypeName(fieldType) : null
    if (name && bare) map.set(name, bare)
  }
  return map
}

/** Searches every file for `typeName` and returns its bound fields plus which file declared it. */
export function resolveDtoBinding(
  typeName: string,
  files: { path: string; root: SyntaxNode }[]
): { file: string; fields: BoundField[] } | null {
  for (const file of files) {
    const fields = findStructFields(file.root, typeName)
    if (fields !== null) return { file: file.path, fields }
  }
  return null
}

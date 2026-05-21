import { readFileSync } from "fs"
import Parser from "tree-sitter"
// @ts-ignore — tree-sitter-php has no bundled types
import PHP from "tree-sitter-php"

// Resolved PHP class constants: ClassName → { CONST_NAME → "value" }
export type ConstantMap = Record<string, Record<string, string>>

const _parser = new Parser()
_parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)

export function parseConstantClass(filePath: string): ConstantMap {
  const source = readFileSync(filePath, "utf-8")
  const tree = _parser.parse(source)
  const map: ConstantMap = {}
  walkNode(tree.rootNode, null, map)
  return map
}

function walkNode(
  node: Parser.SyntaxNode,
  currentClass: string | null,
  map: ConstantMap
): void {
  if (node.type === "class_declaration") {
    const nameNode = node.childForFieldName("name")
    const name = nameNode?.text ?? null
    if (name) {
      map[name] = {}
      for (const child of node.children) {
        walkNode(child, name, map)
      }
    }
    return
  }

  if (node.type === "const_declaration" && currentClass) {
    for (const child of node.children) {
      if (child.type === "const_element") {
        // const_element has positional children: [name] [=] [value]
        const nameNode  = child.children[0]
        const valueNode = child.children[2]
        if (nameNode && valueNode) {
          const content = valueNode.children?.find((c: Parser.SyntaxNode) => c.type === "string_content")
          map[currentClass][nameNode.text] = content?.text ?? unquote(valueNode.text)
        }
      }
    }
    return
  }

  for (const child of node.children) {
    walkNode(child, currentClass, map)
  }
}

function unquote(s: string): string {
  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  ) {
    return s.slice(1, -1)
  }
  return s
}

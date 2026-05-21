import { readFileSync } from "fs"
import Parser from "tree-sitter"
// @ts-ignore
import PHP from "tree-sitter-php"

const _parser = new Parser()
_parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)

// ---- Public API -------------------------------------------------------

export interface FormRequestParam {
  shortName: string   // e.g. "UpdateTaskRequest"
  fqcn:      string   // e.g. "App\Modules\Task\Requests\UpdateTaskRequest"
  paramName: string   // e.g. "$request"
}

export interface AuthorizeCall {
  ability:   string   // first string arg, e.g. "update"
  mechanism: string   // full call text, e.g. "$this->authorize('update', $task)"
}

export interface ControllerL1 {
  useMap:        Map<string, string>   // shortName → FQCN from use statements
  formRequests:  FormRequestParam[]
  authorizeCalls: AuthorizeCall[]
}

// Classes that must NOT be treated as FormRequest nodes
const SKIP_FQCN = new Set([
  "Request",
  "Illuminate\\Http\\Request",
  "Illuminate\\Foundation\\Http\\FormRequest",
])

export function parseControllerMethod(
  filePath: string,
  methodName: string
): ControllerL1 | null {
  let source: string
  try {
    source = readFileSync(filePath, "utf-8")
  } catch {
    return null
  }

  const tree  = _parser.parse(source)
  const root  = tree.rootNode
  const useMap = extractUseMap(root)

  const methodNode = findMethod(root, methodName)
  if (!methodNode) {
    return { useMap, formRequests: [], authorizeCalls: [] }
  }

  return {
    useMap,
    formRequests:   extractFormRequests(methodNode, useMap),
    authorizeCalls: extractAuthorizeCalls(methodNode),
  }
}

// ---- Use-statement extraction -----------------------------------------

export function extractUseMap(root: Parser.SyntaxNode): Map<string, string> {
  const map = new Map<string, string>()
  gatherUseDecls(root, map)
  return map
}

function gatherUseDecls(node: Parser.SyntaxNode, map: Map<string, string>): void {
  for (const child of node.children as Parser.SyntaxNode[]) {
    if (child.type === "namespace_use_declaration") {
      for (const sub of child.children as Parser.SyntaxNode[]) {
        if (sub.type === "namespace_use_clause") {
          const qualName  = (sub.children as Parser.SyntaxNode[]).find(
            (c) => c.type === "qualified_name" || c.type === "name"
          )
          const aliasNode = (sub.children as Parser.SyntaxNode[]).find(
            (c) => c.type === "alias_clause"
          )
          if (qualName) {
            const fqcn      = qualName.text
            const shortName = aliasNode
              ? ((aliasNode.children as Parser.SyntaxNode[]).find((c) => c.type === "name")?.text ?? lastSegment(fqcn))
              : lastSegment(fqcn)
            map.set(shortName, fqcn)
          }
        }
      }
    } else {
      gatherUseDecls(child, map)
    }
  }
}

function lastSegment(fqcn: string): string {
  return fqcn.split("\\").pop() ?? fqcn
}

// ---- Method finder ----------------------------------------------------

function findMethod(root: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null {
  for (const child of root.children) {
    const found = findMethodIn(child, name)
    if (found) return found
  }
  return null
}

function findMethodIn(node: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null {
  if (node.type === "method_declaration") {
    const nameNode = node.childForFieldName("name")
    if (nameNode?.text === name) return node
  }

  for (const child of node.children) {
    const found = findMethodIn(child, name)
    if (found) return found
  }
  return null
}

// ---- FormRequest extraction -------------------------------------------

function extractFormRequests(
  methodNode: Parser.SyntaxNode,
  useMap: Map<string, string>
): FormRequestParam[] {
  const results: FormRequestParam[] = []

  const paramsNode = methodNode.childForFieldName("parameters")
  if (!paramsNode) return results

  for (const param of paramsNode.children) {
    if (param.type !== "simple_parameter") continue

    const typeNode = param.childForFieldName("type")
    if (!typeNode) continue

    const typeName = typeNode.text.trim()

    // Skip bare Request (Illuminate's base request)
    if (SKIP_FQCN.has(typeName)) continue

    const fqcn = useMap.get(typeName) ?? typeName
    if (SKIP_FQCN.has(fqcn)) continue

    // Only include classes that look like FormRequests
    if (!typeName.endsWith("Request")) continue

    const varNode =
      param.childForFieldName("variable_name") ??
      param.childForFieldName("name") ??
      (param.children as Parser.SyntaxNode[]).find((c) => c.type === "variable_name")

    results.push({ shortName: typeName, fqcn, paramName: varNode?.text ?? "$request" })
  }

  return results
}

// ---- authorize() extraction -------------------------------------------

function extractAuthorizeCalls(methodNode: Parser.SyntaxNode): AuthorizeCall[] {
  const results: AuthorizeCall[] = []
  const body = methodNode.childForFieldName("body")
  if (!body) return results
  gatherAuthorizeCalls(body, results)
  return results
}

function gatherAuthorizeCalls(node: Parser.SyntaxNode, results: AuthorizeCall[]): void {
  if (node.type === "member_call_expression") {
    const obj  = node.childForFieldName("object")
    const name = node.childForFieldName("name")
    if (obj?.text === "$this" && name?.text === "authorize") {
      const argsNode = node.childForFieldName("arguments")
      if (argsNode) {
        const argValues = (argsNode.children as Parser.SyntaxNode[])
          .filter((c) => c.type === "argument")
          .map((c) => c.firstNamedChild)
          .filter((c): c is Parser.SyntaxNode => c !== null)
        const ability = argValues[0] ? resolveStringNode(argValues[0]) : "unknown"
        results.push({ ability, mechanism: node.text })
      }
    }
  }

  for (const child of node.children as Parser.SyntaxNode[]) {
    gatherAuthorizeCalls(child, results)
  }
}

function resolveStringNode(node: Parser.SyntaxNode): string {
  if (node.type === "string") {
    const content = (node.children as Parser.SyntaxNode[]).find((c) => c.type === "string_content")
    return content?.text ?? node.text.slice(1, -1)
  }
  return node.text
}

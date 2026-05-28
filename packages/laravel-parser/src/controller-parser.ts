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

export interface ServiceCall {
  propertyName: string   // injected property name, e.g. "permissionService"
  serviceClass: string   // short class name, e.g. "PermissionService"
  serviceFqcn:  string   // FQCN, e.g. "App\Modules\Access\Services\PermissionService"
  method:       string   // called method, e.g. "hasPermission"
  args:         string[] // string literal args extracted from the call site
}

export interface ConstructorMiddleware {
  raw:    string    // e.g. "auth:web,subdealer"
  except: string[]  // method names excluded from this middleware
  only:   string[]  // if non-empty, middleware only applies to these methods
}

export interface ControllerL1 {
  useMap:               Map<string, string>
  formRequests:         FormRequestParam[]
  authorizeCalls:       AuthorizeCall[]
  serviceCalls:         ServiceCall[]
  constructorMiddleware: ConstructorMiddleware[]
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
  let tree: ReturnType<typeof _parser.parse>
  try {
    source = readFileSync(filePath, "utf-8")
    tree = _parser.parse(source)
  } catch {
    return null
  }
  const root  = tree.rootNode
  const useMap = extractUseMap(root)

  const methodNode = findMethod(root, methodName)
  const constructorMiddleware = gatherConstructorMiddleware(root)

  if (!methodNode) {
    return { useMap, formRequests: [], authorizeCalls: [], serviceCalls: [], constructorMiddleware }
  }

  const injections = extractConstructorInjections(root, useMap)
  const methodInjections = extractMethodParamInjections(methodNode, useMap)
  // Merge: method params take precedence over constructor for same var name
  const allInjections = new Map([...injections, ...methodInjections])

  const formRequests   = extractFormRequests(methodNode, useMap)
  const authorizeCalls = extractAuthorizeCalls(methodNode)
  const serviceCalls   = extractServiceCalls(methodNode, allInjections, useMap)

  // Depth-1 private method traversal: follow $this->helper() calls into the
  // same class, but do not recurse further to avoid graph blow-up.
  const privateNames = extractPrivateMethodCallNames(methodNode)
  for (const name of privateNames) {
    const privateMethod = findMethod(root, name)
    if (!privateMethod) continue
    authorizeCalls.push(...extractAuthorizeCalls(privateMethod))
    serviceCalls.push(...extractServiceCalls(privateMethod, allInjections, useMap))
  }

  // Deduplicate service calls by propertyName+method (same call site from two
  // traversal paths should not produce two nodes).
  const seenSvc = new Set<string>()
  const uniqueServiceCalls = serviceCalls.filter((sc) => {
    const key = `${sc.propertyName}::${sc.method}`
    if (seenSvc.has(key)) return false
    seenSvc.add(key)
    return true
  })

  return {
    useMap,
    formRequests,
    authorizeCalls,
    serviceCalls: uniqueServiceCalls,
    constructorMiddleware,
  }
}

// ---- Use-statement extraction -----------------------------------------

export function extractUseMap(root: Parser.SyntaxNode): Map<string, string> {
  const map = new Map<string, string>()
  gatherUseDecls(root, map)
  return map
}

function registerUseClause(clause: Parser.SyntaxNode, prefix: string, map: Map<string, string>): void {
  const qualName  = (clause.children as Parser.SyntaxNode[]).find(
    (c) => c.type === "qualified_name" || c.type === "name"
  )
  const aliasNode = (clause.children as Parser.SyntaxNode[]).find(
    (c) => c.type === "alias_clause"
  )
  if (!qualName) return
  const raw  = qualName.text.trim()
  if (!raw)  return
  const fqcn = prefix ? `${prefix}\\${raw}` : raw
  const shortName = aliasNode
    ? ((aliasNode.children as Parser.SyntaxNode[]).find((c) => c.type === "name")?.text ?? lastSegment(fqcn))
    : lastSegment(fqcn)
  map.set(shortName, fqcn)
}

function gatherUseDecls(node: Parser.SyntaxNode, map: Map<string, string>): void {
  for (const child of node.children as Parser.SyntaxNode[]) {
    if (child.type === "namespace_use_declaration") {
      // Detect PHP 7+ grouped use: `use Ns\{A, B, C};`
      const group  = (child.children as Parser.SyntaxNode[]).find((c) => c.type === "namespace_use_group")
      const prefix = (child.children as Parser.SyntaxNode[]).find((c) => c.type === "namespace_name")?.text ?? ""

      if (group) {
        for (const sub of group.children as Parser.SyntaxNode[]) {
          if (sub.type === "namespace_use_clause") registerUseClause(sub, prefix, map)
        }
      } else {
        for (const sub of child.children as Parser.SyntaxNode[]) {
          if (sub.type === "namespace_use_clause") registerUseClause(sub, "", map)
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

// ---- Private method call extraction ----------------------------------
// Finds $this->methodName() calls (direct, not through a property chain).
// These are candidates for depth-1 traversal into the same class.

function extractPrivateMethodCallNames(methodNode: Parser.SyntaxNode): string[] {
  const names = new Set<string>()
  const body = methodNode.childForFieldName("body")
  if (!body) return []
  gatherPrivateMethodCallNames(body, names)
  return Array.from(names)
}

function gatherPrivateMethodCallNames(node: Parser.SyntaxNode, names: Set<string>): void {
  if (node.type === "member_call_expression") {
    const objNode  = node.childForFieldName("object")
    const nameNode = node.childForFieldName("name")
    // $this->method() — object is "$this" directly (not a property chain)
    if (objNode?.text === "$this" && nameNode) {
      names.add(nameNode.text)
    }
  }
  for (const child of node.children as Parser.SyntaxNode[]) {
    gatherPrivateMethodCallNames(child, names)
  }
}

function resolveStringNode(node: Parser.SyntaxNode): string {
  if (node.type === "string") {
    const content = (node.children as Parser.SyntaxNode[]).find((c) => c.type === "string_content")
    return content?.text ?? node.text.slice(1, -1)
  }
  return node.text
}

// ---- Constructor middleware extraction --------------------------------

/**
 * Parse $this->middleware() calls from the __construct() body.
 *
 * Handles:
 *   $this->middleware('auth:web')
 *   $this->middleware('auth:web,subdealer', ['except' => ['login']])
 *   $this->middleware('auth:api', ['only' => ['store']])
 *
 * Note: method-chaining form ($this->middleware('auth')->except([...]))
 * is not yet supported — treated as middleware with no filters.
 */
function gatherConstructorMiddleware(root: Parser.SyntaxNode): ConstructorMiddleware[] {
  const constructNode = findMethod(root, "__construct")
  if (!constructNode) return []
  const body = constructNode.childForFieldName("body")
  if (!body) return []

  const results: ConstructorMiddleware[] = []
  collectMiddlewareCalls(body, results)
  return results
}

function collectMiddlewareCalls(node: Parser.SyntaxNode, results: ConstructorMiddleware[]): void {
  if (node.type === "member_call_expression") {
    const obj  = node.childForFieldName("object")
    const name = node.childForFieldName("name")

    if (obj?.text === "$this" && name?.text === "middleware") {
      const argsNode = node.childForFieldName("arguments")
      if (argsNode) {
        const argList = (argsNode.children as Parser.SyntaxNode[]).filter(
          (c) => c.type === "argument"
        )
        if (argList.length >= 1) {
          const firstVal = argList[0].firstNamedChild
          if (firstVal) {
            const raw = resolveStringNode(firstVal)
            if (raw) {
              let except: string[] = []
              let only:   string[] = []

              if (argList.length >= 2) {
                const secondVal = argList[1].firstNamedChild
                if (secondVal?.type === "array_creation_expression") {
                  for (const elem of secondVal.namedChildren as Parser.SyntaxNode[]) {
                    if (elem.type !== "array_element_initializer") continue
                    // namedChildren: [key_string, value_array] (=> token is anonymous)
                    const named = elem.namedChildren as Parser.SyntaxNode[]
                    if (named.length < 2) continue
                    const key = resolveStringNode(named[0])
                    const valNode = named[1]
                    if (valNode.type === "array_creation_expression") {
                      const vals = extractStringArrayValues(valNode)
                      if (key === "except") except = vals
                      else if (key === "only") only = vals
                    }
                  }
                }
              }

              results.push({ raw, except, only })
            }
          }
        }
      }
    }
  }

  for (const child of node.children as Parser.SyntaxNode[]) {
    collectMiddlewareCalls(child, results)
  }
}

function extractStringArrayValues(arrayNode: Parser.SyntaxNode): string[] {
  const results: string[] = []
  for (const elem of arrayNode.namedChildren as Parser.SyntaxNode[]) {
    if (elem.type !== "array_element_initializer") continue
    const named = elem.namedChildren as Parser.SyntaxNode[]
    // Simple value (no key): namedChildren has exactly 1 element
    if (named.length === 1 && named[0].type === "string") {
      results.push(resolveStringNode(named[0]))
    }
  }
  return results
}

// ---- Constructor injection extraction --------------------------------

/**
 * Parse __construct parameters to build propertyName → FQCN map.
 * Handles PHP 8 constructor promotion (private/public/protected modifiers).
 */
function extractConstructorInjections(
  root: Parser.SyntaxNode,
  useMap: Map<string, string>
): Map<string, string> {
  const constructNode = findMethod(root, "__construct")
  if (!constructNode) return new Map()

  const paramsNode = constructNode.childForFieldName("parameters")
  if (!paramsNode) return new Map()

  const map = new Map<string, string>()

  for (const param of paramsNode.children as Parser.SyntaxNode[]) {
    // Works for simple_parameter and property_promotion_parameter
    const typeNode = param.childForFieldName("type")
    const varNode  = (param.children as Parser.SyntaxNode[]).find(
      (c) => c.type === "variable_name"
    )
    if (!typeNode || !varNode) continue

    const typeName = typeNode.text.trim()

    // Skip primitive and framework base types
    if (!typeName || typeName[0] === typeName[0].toLowerCase()) continue
    if (["Request", "Closure", "Response"].includes(typeName)) continue

    const fqcn    = useMap.get(typeName) ?? typeName
    const varName = varNode.text.replace(/^\$/, "")
    map.set(varName, fqcn)
  }

  return map
}

/**
 * Extract typed non-primitive method parameters as varName → FQCN injections.
 * Handles patterns like: public function store(OrderService $orderService, ...)
 */
function extractMethodParamInjections(
  methodNode: Parser.SyntaxNode,
  useMap: Map<string, string>
): Map<string, string> {
  const map = new Map<string, string>()
  const paramsNode = methodNode.childForFieldName("parameters")
  if (!paramsNode) return map

  for (const param of paramsNode.children as Parser.SyntaxNode[]) {
    if (param.type !== "simple_parameter") continue
    const typeNode = param.childForFieldName("type")
    const varNode  = (param.children as Parser.SyntaxNode[]).find(
      (c) => c.type === "variable_name"
    )
    if (!typeNode || !varNode) continue

    const typeName = typeNode.text.trim()
    if (!typeName || typeName[0] === typeName[0].toLowerCase()) continue
    if (["Request", "Closure", "Response"].includes(typeName)) continue
    // Skip FormRequest subclasses (already handled by extractFormRequests)
    if (typeName.endsWith("Request")) continue

    const fqcn    = useMap.get(typeName) ?? typeName
    const varName = varNode.text.replace(/^\$/, "")
    map.set(varName, fqcn)
  }

  return map
}

// ---- Service call extraction -----------------------------------------

function extractServiceCalls(
  methodNode: Parser.SyntaxNode,
  injections: Map<string, string>,
  _useMap: Map<string, string>
): ServiceCall[] {
  const results: ServiceCall[] = []
  const body = methodNode.childForFieldName("body")
  if (!body) return results
  gatherServiceCalls(body, injections, results)
  return results
}

function gatherServiceCalls(
  node: Parser.SyntaxNode,
  injections: Map<string, string>,
  results: ServiceCall[]
): void {
  if (node.type === "member_call_expression") {
    const objNode  = node.childForFieldName("object")
    const nameNode = node.childForFieldName("name")

    if (nameNode) {
      // Pattern 1: $this->propertyName->method(args)
      if (objNode?.type === "member_access_expression") {
        const innerObj = objNode.childForFieldName("object")
        const propNode = objNode.childForFieldName("name")

        if (innerObj?.text === "$this" && propNode) {
          const prop = propNode.text
          const fqcn = injections.get(prop)

          if (fqcn) {
            const shortName  = fqcn.split("\\").pop() ?? fqcn
            const argsNode   = node.childForFieldName("arguments")
            const stringArgs = argsNode ? extractStringCallArgs(argsNode) : []

            results.push({
              propertyName: prop,
              serviceClass: shortName,
              serviceFqcn:  fqcn,
              method:       nameNode.text,
              args:         stringArgs,
            })
          }
        }
      }

      // Pattern 2: $localVar->method(args) — method-injected service
      if (objNode?.type === "variable_name") {
        const varName = objNode.text.replace(/^\$/, "")
        const fqcn    = injections.get(varName)

        if (fqcn) {
          const shortName  = fqcn.split("\\").pop() ?? fqcn
          const argsNode   = node.childForFieldName("arguments")
          const stringArgs = argsNode ? extractStringCallArgs(argsNode) : []

          results.push({
            propertyName: varName,
            serviceClass: shortName,
            serviceFqcn:  fqcn,
            method:       nameNode.text,
            args:         stringArgs,
          })
        }
      }
    }
  }

  for (const child of node.children as Parser.SyntaxNode[]) {
    gatherServiceCalls(child, injections, results)
  }
}

function extractStringCallArgs(argsNode: Parser.SyntaxNode): string[] {
  return (argsNode.children as Parser.SyntaxNode[])
    .filter((c) => c.type === "argument")
    .flatMap((c) => {
      const val = c.firstNamedChild
      if (!val) return []
      if (val.type === "string") {
        const content = (val.children as Parser.SyntaxNode[]).find(
          (sc) => sc.type === "string_content"
        )
        return content?.text ? [content.text] : []
      }
      return []
    })
}
